# Agent Note: run_code 失败使用程序自身的坐标

Status: implemented

[English](2026-08-13-run-code-program-coordinates.md) | 中文

## Problem

`run_code` 抛出的异常，此前以 V8 为程序所在动态构造函数生成的原始 stack 直接送达模型，而其中每个栈帧的两半信息说的都不是程序本身。

行号把模型第一行之前的三行合成代码也算了进去：V8 的 `async function anonymous(<参数>` 头部、其 `) {` 一行，以及 worker 自己的 `'use strict';` 指令。因此程序第 2 行的失败会被报成第 5 行。宿主侧在这一点上很谨慎——类型剥离的包裹保持位置不变，正是为了让函数体切回来时保留模型自己的行列——而 worker 随后把每一行都平移了三行。模型据此自我纠正时读到的是错误的语句，而且程序越长，那个错误行号看起来越可信。

位置的另一半则写出了 worker 文件在宿主磁盘上的绝对路径。在打包的桌面应用中，它是 `/Applications/DeepSeek Harness.app/Contents/Resources/backend/node_modules/@deepseek-ai/dsh-code-runtime-worker-thread/lib/worker.cjs`，于是每条异常诊断都在告诉模型 harness 装在哪里，却没有给出任何可据以行动的信息。

暴露该问题的实例：程序第 2 行的 `const [selfMod] = await tools.glob({ pattern: … })`——`glob` 返回的是 `{ root, paths }` 而非数组——产生了 `TypeError: (intermediate value) is not iterable\n    at eval (eval at runWorkerMain (/Applications/…/worker.cjs:887:31), <anonymous>:5:19)`。

被类型剥离拒绝的程序更糟：完全没有位置信息。`stripTypeScriptTypes` 抛出的错误在 `stack` 中带有包裹后的行号、源码窗口和插入符号所在列，而宿主只取了 `error.message`——于是一处写坏的对象字面量，无论程序多长，读到的都只有 `Unexpected token \`{\`. Expected identifier, string literal, numeric literal or [ for the computed key` 这一句。

## Decision

worker 的 bootstrap 会在诊断跨越端口之前，用程序自身的坐标重述抛出错误的 stack。`normalizeProgramStack` 原样保留第一个栈帧之前的全部内容——包括多行消息，把 V8 归属给该编译程序的每个栈帧改写为 `program:<行>:<列>`，并丢弃其余所有栈帧：本文件、Node 内部，以及它们写出的宿主路径。V8 给程序自身顶层栈帧的名字是 `eval`，它以裸形式呈现（`at program:2:19`）；其他名字则保留标识符与 `async` 前缀（`at async step (program:2:3)`）。

`programHeaderLines` 测量这段平移，而不是假定它：在被构造的那个函数的 `Function.prototype.toString()` 中原样定位函数体，数出它之前的行数，再加上指令本身占的行。V8 的头部渲染方式并不是谁欠我们的契约，而这段算术只在失败路径上执行。

从未编译成功的函数体只报告消息，完全不给出位置：被构造的函数并不存在，没有任何东西能把上报的行与写下的行关联起来，编造一个比省略更糟。

宿主按同样的原则翻译剥离阶段的拒绝。`programSyntaxLocation` 读取剥离器开头的 `:<行>` 标记，以及标出出错跨度的插入符号行，减去剥离包裹自身的行数——该行数由包裹文本推导，而非另行写死——渲染成 `program:<行>:<列>`；诊断保留错误的 name，因此解析失败读起来与其他失败一致。有两种情况宁可不给位置也不给错的：诊断没有行标记，以及行落在程序之外——未闭合的程序正是如此，解析器会走到包裹追加的那个花括号。缺少插入符号时仍会单独报告行号。

`program-location.ts` 同时拥有 `program:<行>:<列>` 的渲染与这套还原逻辑，因为两条失败路径运行在不同进程中——解析在宿主，抛出在 worker——而先后读到它们的模型不应遇到两套说法。

`CodeRunFailure` 的 `'exception'` kind 在 seam 层承载这项义务——消息用程序自身的坐标陈述失败，且不写出任何实现文件或宿主路径——因此未来的后端会翻译自己的 traceback，而不是重演同一次泄漏。

## Verification

`normalizeProgramStack` 与 `programHeaderLines` 是纯函数，直接接受单元测试：来自打包应用的真实 stack 映射为 `at program:2:19`，多行消息保留两行，方法栈帧与被 await 的栈帧保留各自名称，无法测量头部时则丢弃全部栈帧。`programHeaderLines` 断言的是性质而非常量——跳过测得的行数正好落在模型的第一行——因此 V8 头部渲染方式的改变无法伪装成正确。

进程内的 `runWorkerMain` 测试重放了最初的实例：对工具返回的对象做数组解构，报告的正是 `TypeError: (intermediate value) is not iterable\n    at program:2:17`，而 `return (` 报告单行 `SyntaxError`。一个真实 worker 测试在启动的隔离环境中同时钉住具名辅助函数与顶层（`at first (program:2:40)`、`at program:3:8`），那里被过滤丢弃的栈帧正是真实 worker 文件的。

解析路径通过 `runtime.run()` 对真实剥离器钉住：写坏的对象字面量报告 `at program:2:56`，`enum E { A }` 报告 `at program:1:1`，`const x = (` 只报告单行消息。`programSyntaxLocation` 自己的测试覆盖插入符号列、没有插入符号的诊断、两种落在程序之外的行，以及没有行标记的诊断。

## Alternatives considered

**减去硬编码的三行。** 已否决：这个常量由 V8 决定改动，我们只负责弄错，而错误的偏移无从察觉——每个上报的行号都照样看着合理。已经失败的程序上多做一次 `indexOf`，代价可以忽略。

**改用 `vm.compileFunction` 编译，给程序 `filename` 与 `lineOffset`。** 已否决：V8 确实会正确归属程序自身的栈帧，但 harness 栈帧及其宿主路径仍在同一条 stack 上，过滤无论如何都要做；而且要让异步函数体合法，还得把程序再包一层函数，这改变了执行路径，换来的却是过滤本已提供的东西。

**在渲染诊断的 `dsh-tools` 中做归一化。** 已否决：头部行数只有在构造该函数的地方才可知，而 seam 规定失败消息送达时就应可直接交给模型——由一个消费方修补，就意味着每个消费方都得修补。

**保留 harness 栈帧以便调试。** 已否决：这段文本的唯一读者是模型，这些栈帧没有指向任何它能处理的东西，而 harness 自身的缺陷是在宿主日志里诊断的。

**把出错的源码行引用进消息，或原样转发剥离器的源码窗口。** 已否决：模型在同一轮里就有自己的程序文本，该片段会与已捕获输出争夺同一份有界字节预算，而剥离器的窗口还会把模型从未写过的包裹行与它自己的代码并排展示。

**把落在程序之外的行钳制到程序最后一行。** 已否决：那会把"解析器越过了末尾"变成对某条具体语句的确信断言，而这正是本 Agent Note 要消除的失效模式。

## Consequences

失败的程序现在指向模型写下的那条语句，因此下一次尝试修改的是那一行，而不是它下方三行的位置，并且任何诊断都不再携带安装位置。绑定内部产生的拒绝，会以其消息加上等待它的那些程序栈帧的形式到达——创建它的 worker 栈帧已被移除。`'exception'` 是唯一消息经过翻译的失败类别；预算、abort 与底座死亡本就以各自的术语表述。

有两种形态刻意不给位置：行落在程序之外的诊断，以及 worker 无法构造的函数体。二者都是诚实的空缺，而非就近猜测，并且都保留了说明解析器期望什么的消息。
