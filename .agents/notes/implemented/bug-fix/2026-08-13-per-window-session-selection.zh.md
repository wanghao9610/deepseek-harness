# Agent Note: 窗口所显示的会话属于该窗口

Status: implemented

[English](2026-08-13-per-window-session-selection.md) | 中文

## Problem

Web 客户端把当前 Session selection 放在唯一一个 `localStorage` 单元 `dsh.sessions.current` 中，并在构造 `SessionRuntime` 时读取一次。`localStorage` 按源划分，同一浏览器 profile 的每个窗口共用它，因此同源上的第二个窗口会恢复出第一个窗口的 selection，并打开它已经在显示的那个会话。两个窗口于是共跑同一场对话：在任一窗口发出的消息都会出现在两边；而且各自持续写入这个共享单元，也就互相覆盖了对方所处的位置。

用户是在桌面应用上遇到这一点的。它的**新建窗口**会在同一默认分区、同一本地回环源上再开一个 `BrowserWindow`，于是出现的就是之前那个窗口——本次工作正是由该反馈发起的。`dsh web` 的两个浏览器标签页一直是同样的行为；桌面外壳只是让它变成了一次按键就能走到的路径。

## Decision

selection 按窗口保存，并由打开窗口的外壳说明该窗口是不是新窗口。

`createSnapshotStore` 的 `persist` 选项新增作用域。`origin` 就是此前的行为，并且仍是其余所有持久化 store 的默认值。`window` 同时写入 `sessionStorage` 与 `localStorage`，读取时优先取本窗口自己的单元。`sessionStorage` 按顶层浏览上下文划分，能挺过重新加载、renderer 崩溃，以及在同一标签页内导航离开再回来，这正是 selection 所需的生命期；共享单元则降格为冷启动种子，因此从未选择过任何会话的窗口从浏览器上次停留处开始，此后各自分化。`dsh.sessions.current` 是唯一声明该作用域的 store。

`consumeWindowBoot` 每次页面加载读取一次 `new` 这一个地址参数，并用 `history.replaceState` 将其剥离。客户端装配层在构造两个领域服务之前读取它，并把同一个答案交给两者：`SessionRuntime` 丢弃恢复出的 selection，`WorkspaceRuntime.startInitialSelection` 改用 `session.create` 新建会话，而不再调用 `connectWorkspace`。这个替换正是后半部分的全部意义——`connectWorkspace` 会复用最近活跃 Workspace 的空白会话，而那恰恰是另一个窗口很可能正停在其上的会话，因此只要双方都还没输入任何内容，复用空白会话就会把两个窗口重新放回同一场对话。

桌面外壳仅为**新建窗口**在运行时地址上带该参数。首个窗口与 Dock 激活加载不带参数的地址并恢复上次的会话，这是人们重新打开一个应用时期待的行为。`WindowHost` 用 `WeakSet` 保存该请求，并在窗口首次加载 harness 界面时消耗它，因为运行时重启会重新路由每个已打开的窗口，而这些都是同一个窗口，并非又一个新窗口。

在到达时即剥离该参数，正是让重新加载意味着「再给我看一次这个」的原因。留在地址栏里的指令会在每次重新加载时再次生效，每次都新建一个会话。

## Alternatives considered

**为每个窗口单独设置 Electron session partition。** 外壳可以给每个新窗口一个自己的内存 `partition`，无需改动 Web 客户端即可隔离存储。它并不能修好用户能看见的任何东西：没有持久化的 selection，新窗口就会落到最近活跃 Workspace 的空白会话上，而第一个窗口正显示着它，两者仍然共用一场对话。它还会隔离该窗口存储的其他一切，并且放着两个浏览器标签页的同一问题不管——这个缺陷本就属于 Web 界面。

**selection 保留在 `localStorage`，只增加 `new` 参数。** 更简单，也能修好被报告的症状。它让窗口在此之后仍然耦合：每个窗口都继续写同一个单元，因此运行时重启——它会让每个已打开的窗口重新完整加载一次页面——会把所有窗口带到最后一个切换过会话的窗口所在之处。

**把 selection 只放进 `sessionStorage`。** 干净，但会丢掉冷启动恢复：`sessionStorage` 不会比标签页活得更久，重新启动应用将落在空白会话上，而不是用户离开时的那场对话。把共享单元留作种子，代价是每次 selection 变化多写一次，换来保住该行为。

**由外壳经 API 创建会话并传入其 id。** 完全确定，但会让外壳变成一个 harness 客户端：`session.create` 需要一个 Workspace，也就意味着外壳要携带 Workspace 知识与一套创建策略。按设计外壳不增加任何 harness 能力；`new` 只陈述意图，把「新会话如何产生」留给 Web 客户端决定。

**让新窗口落在 New Session 首屏、完全不带会话。** 在用户真正发出内容前不新建任何会话，因此反复按 ⌘N 不留下任何东西。作为默认行为它被否决了：显示一张空页面的窗口并不是别处「新建窗口」所给予的；而没有任何 Workspace 的窗口仍会落在那里，这与 `startSession` 采用的回退相同。

## Consequences

同一 profile 的两个窗口持有两个会话，不再相互牵动。重新打开桌面应用仍会在其首个窗口恢复上次的会话。代价是 ⌘N 总会新建会话，因此反复按而不输入会在列表里留下空白会话——这是「保证该窗口显示的不是另一个窗口所持有的内容」的价钱，而空白会话在列表界面中是隐藏的。

分化以源为前提。运行时在不同端口回来即是不同的源，其中每个窗口的存储都是空的，也就都回落到共享种子——窗口会重新汇合，直到各自作出选择。桌面外壳的本地运行时每次启动都会占用一个本地回环端口，因此重启正是会撞上这一点的情形。

普通的第二个浏览器标签页仍会落在种子所指的会话上，因为没有任何人向它请求新会话。这是浏览器为一个应用另开标签页时自身的习惯，而想要另一种结果的人可以使用该地址参数。

## Testing

`store.client.spec.ts` 钉住作用域规则：window 作用域优先读自己的单元、以共享单元播种、两者都写，以及在没有 `sessionStorage` 的环境下只回落到共享单元——即 node 通道，其余所有持久化 store 在那里保持此前行为不变。`window-boot.client.spec.ts` 钉住该参数及其消耗。`sessions-service.client.spec.ts` 与 `workspaces-service.client.spec.ts` 钉住新窗口所做之事的两半：恢复出的 selection 即使能与列表校验通过也照样丢弃，以及跳过该 workspace 的空白会话、改为新的 `session.create`。

`apps/web/tests/new-window-session.e2e.ts` 是装配后的证明，而且它需要**同一个**浏览器上下文中的两个页面——`browser.newPage` 会给每个页面各自的上下文，其隔离存储会让该场景在缺陷仍在时也通过。它在真实 host 上以 `?new=1` 打开第二个窗口，断言两个不同会话、host 上有两个会话、地址中该参数已被消耗、重新加载不新建任何会话，以及第一个窗口从未移动。

Electron 外壳这一半没有任何 gate 覆盖；桌面应用整体就没有 CI gate（[桌面应用 Agent Note](../architecture/2026-08-13-electron-desktop-application.md)）。
