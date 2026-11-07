'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { classifyCrash, classifyStopped, watchdogWindowClass } = require('../dist/index.js');

// —— 窗口看门狗触发面（2026-11-01 用户报障：直连进服关窗后进程残留 → 非 Applet 直连也纳入）——
const APPLET = 'uk.betacraft.legacyfix.applet.AppletLauncher';
const cfgOf = (mainClass, gameArgs) => ({ mainClass, gameArgs });

test('watchdogWindowClass：Applet 容器恒挂 SunAwtFrame（带不带直连都一样）', () => {
  assert.equal(watchdogWindowClass(cfgOf(APPLET, [])), 'SunAwtFrame');
  assert.equal(watchdogWindowClass(cfgOf(APPLET, ['--server', 'mc.example.com', '--port', '25565'])), 'SunAwtFrame');
});

test('watchdogWindowClass：非 Applet 直连（gameArgs 含 --server）挂 LWJGL；常规单人/无直连不挂', () => {
  assert.equal(watchdogWindowClass(cfgOf('net.minecraft.client.Minecraft', ['--server', '1.2.3.4', '--port', '25565'])), 'LWJGL');
  assert.equal(watchdogWindowClass(cfgOf('net.minecraft.client.Minecraft', [])), null);
  assert.equal(watchdogWindowClass(cfgOf('net.minecraft.client.Minecraft', ['--port', '25565'])), null);
});

test('正常退出 → null', () => {
  assert.equal(classifyCrash('anything', 0), null);
});

test('OutOfMemoryError → out-of-memory，headline 取首个匹配行', () => {
  const out = 'line one\nException in thread "main" java.lang.OutOfMemoryError: Java heap space\nline three';
  const crash = classifyCrash(out, 1);
  assert.equal(crash.category, 'out-of-memory');
  assert.match(crash.headline, /OutOfMemoryError/);
  // 规则命中无死因块 → 弹窗栈缺省
  assert.equal(crash.stack, undefined);
});

test('UnsatisfiedLinkError → unsatisfied-link', () => {
  const crash = classifyCrash('java.lang.UnsatisfiedLinkError: no lwjgl in java.library.path', 1);
  assert.equal(crash.category, 'unsatisfied-link');
});

test('GLXBadContext → gl-init', () => {
  const crash = classifyCrash('org.lwjgl.LWJGLException: X Error -14: GLXBadContext', 1);
  assert.equal(crash.category, 'gl-init');
});

test('lwjgl 原生库缺失 → lwjgl-native', () => {
  const crash = classifyCrash('java.lang.UnsatisfiedLinkError: Failed to load native library: lwjgl.dll', 1);
  // UnsatisfiedLinkError 规则先命中（顺序即契约）
  assert.equal(crash.category, 'unsatisfied-link');
  const other = classifyCrash('LWJGL (CLI) - Could not locate lwjgl native library', 1);
  assert.equal(other.category, 'lwjgl-native');
});

test('java 缺失（spawn ENOENT）→ java-missing', () => {
  const crash = classifyCrash('Error: spawn /opt/java/bin/java ENOENT', null);
  assert.equal(crash.category, 'java-missing');
});

test('未命中规则 → unknown，headline = 退出码行（与控制台退出码行同源指向）', () => {
  const crash = classifyCrash('some noise\nweird failure', 2);
  assert.equal(crash.category, 'unknown');
  assert.equal(crash.headline, 'exit code 2');
});

test('signal 退出（code null）→ unknown，headline = signal', () => {
  const crash = classifyCrash('noise', null, 'SIGKILL');
  assert.equal(crash.category, 'unknown');
  assert.equal(crash.headline, 'signal SIGKILL');
  const unknown = classifyCrash('noise', null);
  assert.equal(unknown.headline, 'signal unknown');
});

test('Stopping! 前有 Java 堆栈 → unknown，headline 并拢到堆栈块顶（Caused by 嵌套不吃最近一段）', () => {
  const out = [
    '[12:00:00] [main/INFO]: Loading mixin',
    'Exception in thread "Client main loop" java.lang.RuntimeException: Failed to start game',
    '\tat net.minecraft.client.Minecraft.run(Minecraft.java:697)',
    'Caused by: java.io.UncheckedIOException: boom',
    '\tat net.example.Some.thing(Some.java:1)',
    '\t... 12 more',
    '[12:00:01] [Server thread/INFO]: Stopping!',
  ].join('\n');
  const crash = classifyCrash(out, 1);
  assert.equal(crash.category, 'unknown');
  assert.equal(crash.headline, 'Exception in thread "Client main loop" java.lang.RuntimeException: Failed to start game');
  // 紧邻块全文（含 Caused by 嵌套行），Stopping! 行本身不入块
  assert.equal(crash.stack, out.split('\n').slice(1, 6).join('\n'));
});

test('Stopping! 但其前无堆栈 → 不拿无关行当死因，落退出码行', () => {
  const crash = classifyCrash('some noise\n[12:00:01] [Server thread/INFO]: Stopping!', 3);
  assert.equal(crash.category, 'unknown');
  assert.equal(crash.headline, 'exit code 3');
});

test('规则命中优先于 Stopping! 堆栈感知', () => {
  const crash = classifyCrash('java.lang.OutOfMemoryError: Java heap space\nStopping!', 1);
  assert.equal(crash.category, 'out-of-memory');
});

test('退出码 0 但 Stopping! 紧邻堆栈块（applet 层 shutdown 后关窗）→ 仍报崩溃', () => {
  const out = [
    'Exception in thread "Applet main loop" java.lang.RuntimeException: shutdown after error',
    '\tat uk.betacraft.legacyfix.Applet.run(Applet.java:1)',
    '[12:00:01] [Server thread/INFO]: Stopping!',
  ].join('\n');
  const crash = classifyCrash(out, 0);
  assert.equal(crash.category, 'unknown');
  assert.equal(crash.headline, 'Exception in thread "Applet main loop" java.lang.RuntimeException: shutdown after error');
});

test('退出码 0 正常退出：Stopping! 恒打，陈旧堆栈隔着日志行不误报（紧邻纪律）', () => {
  const out = [
    'java.lang.RuntimeException: old recovered error',
    '\tat net.old.Thing(Thing.java:1)',
    '[12:00:00] [Server thread/INFO]: Saving worlds',
    '[12:00:01] [Server thread/INFO]: Stopping!',
  ].join('\n');
  assert.equal(classifyCrash(out, 0), null);
});

// —— a1.2.3 实测形态（2026-11-07 日志 = test-launch-2026-11-07T03-13-34-465Z.log；
//    源码核对 = src-minecraft-alpha-v1.2.3 Minecraft.java L540-545 + legacyfix DeAwtPatch）：
//    崩溃路径不经过 stop()（无 Stopping!），裸打异常名（无冒号无前缀），
//    legacyfix run() 尾注入 System.exit(0) → 0 码收场 —— 全靠尾部堆栈块 ——）
const SO_TAIL = [
  'java.lang.StackOverflowError',
  '\tat cx.b(SourceFile:423)',
  '\tat kl.h(SourceFile:49)',
  '\tat kl.a(SourceFile:29)',
  '\tat cx.l(SourceFile:509)',
  'No player with name: Player358',
];

test('a1.2.3 形态①：0 码（legacyfix 注入 exit(0)）+ 无 Stopping! + 裸头行 → 尾部堆栈块命中', () => {
  const crash = classifyCrash(SO_TAIL.join('\n'), 0);
  assert.equal(crash.category, 'stack-overflow');
  assert.equal(crash.headline, 'java.lang.StackOverflowError');
  // 弹窗栈全文 = 死因块 header+body；非栈行（No player…）不入块
  assert.equal(crash.stack, SO_TAIL.slice(0, 5).join('\n'));
});

test('a1.2.3 形态②：JVM fatal 码（0xCFFFFFFF）→ 堆栈块优先于退出码行', () => {
  const crash = classifyCrash(SO_TAIL.join('\n'), 3489660927);
  assert.equal(crash.headline, 'java.lang.StackOverflowError');
});

test('a1.2.3 形态③：僵尸收尸（用户点停止 SIGTERM）→ classifyStopped 仍报堆栈签名', () => {
  const crash = classifyStopped(SO_TAIL.join('\n'));
  assert.equal(crash.category, 'stack-overflow');
  assert.equal(crash.headline, 'java.lang.StackOverflowError');
});

test('classifyStopped：干净收尾（Stopping! + 保存日志）不报崩溃（常规中性停止不变）', () => {
  const out = [
    '[12:00:00] [Server thread/INFO]: Saving worlds',
    '[12:00:01] [Server thread/INFO]: Stopping!',
  ].join('\n');
  assert.equal(classifyStopped(out), null);
});

test('尾部块容忍度：堆栈块距日志末 >8 行 → 不算签名（陈旧崩溃不污染后续正常收尾）', () => {
  const out = [
    'java.lang.StackOverflowError',
    '\tat cx.b(SourceFile:423)',
    ...Array.from({ length: 9 }, (_, i) => `[12:00:0${i}] [Server thread/INFO]: noise ${i}`),
  ].join('\n');
  assert.equal(classifyCrash(out, 0), null);
});

test('裸 header 单行（无 body）不算完整栈签名', () => {
  assert.equal(classifyCrash('some noise\njava.lang.IllegalStateException: mentioned only', 0), null);
});

// —— infdev 20100327+ 形态（src-minecraft-infdev-20100630-2 Minecraft.java L418-424/L296-325）：
//    catch(Exception) 不拦 Error → finally shutdownMinecraftApplet() 先打 Stopping!，
//    JDK uncaught handler 线程死透后才打栈——栈在收尾之后，②须看 Stopping! 之后的尾段。
//    applet 容器启动（本启动器 infdev 路径）无 System.exit → 僵尸 → 看门狗 SIGTERM 收尸。
test('infdev Error 崩溃：栈在 Stopping! 之后（uncaught handler 晚于 finally）→ 尾段签名命中', () => {
  const out = [
    '[12:00:00] [info] some game log',
    'Stopping!',
    'Exception in thread "Thread-2" java.lang.StackOverflowError',
    '\tat net.minecraft.src.World.b(World.java:423)',
    '\tat net.minecraft.src.BlockLeaves.h(BlockLeaves.java:49)',
  ].join('\n');
  const crash = classifyStopped(out);
  assert.equal(crash.category, 'stack-overflow');
  assert.equal(crash.headline, 'Exception in thread "Thread-2" java.lang.StackOverflowError');
  // 弹窗栈 = Stopping! 之后尾段块全文（收尾前的杂散行不入块）
  assert.equal(crash.stack, out.split('\n').slice(2).join('\n'));
});

test('正常退出：陈旧堆栈压在 Stopping! 之前、收尾后无栈 → 不报（尾段扫描保护）', () => {
  const out = [
    'java.lang.RuntimeException: recovered mid-session',
    '\tat net.old.Thing(Thing.java:1)',
    '[12:00:00] [Server thread/INFO]: Saving worlds',
    'Stopping!',
    '[12:00:02] [Server thread/INFO]: AWT shutdown done',
  ].join('\n');
  assert.equal(classifyCrash(out, 0), null);
  assert.equal(classifyStopped(out), null);
});

// —— indev→infdev<0327 下载线程噪音（2026-11-07 用户实测；源码实锤 =
//    ThreadDownloadResources.run() L82-84 catch(IOException)→printStackTrace，
//    daemon 线程拉 www.minecraft.net/resources/ 死链，游戏照常）：
//    短测试会话里此栈恰压尾部，非致命头类名单必须拦住，不得弹未知错误。
const DOWNLOAD_NOISE = [
  '[11:13:40] [info] Starting up',
  'java.net.SocketException: Unexpected end of file from server',
  '\tat sun.net.www.http.HttpClient.parseHTTPHeader(Unknown Source)',
  '\tat sun.net.www.http.HttpClient.parseHTTP(Unknown Source)',
  '\tat java.net.URL.openStream(Unknown Source)',
  '\tat net.minecraft.client.j.run(Unknown Source)',
];

test('下载线程 SocketException 压尾：0 码/收尸 SIGTERM → 不报（非致命头类闸）', () => {
  assert.equal(classifyCrash(DOWNLOAD_NOISE.join('\n'), 0), null);
  assert.equal(classifyStopped(DOWNLOAD_NOISE.join('\n')), null);
});

test('下载线程噪音 + 非零退出 → 落退出码行（噪音头不当 headline）', () => {
  const crash = classifyCrash(DOWNLOAD_NOISE.join('\n'), 1);
  assert.equal(crash.headline, 'exit code 1');
});

test('致命包裹嵌套 Caused by SocketException → 顶层致命类照常报（名单只看顶层）', () => {
  const out = [
    'java.lang.RuntimeException: level load failed',
    '\tat net.minecraft.client.Minecraft.a(Minecraft.java:1)',
    'Caused by: java.net.SocketException: Unexpected end of file from server',
    '\tat net.minecraft.client.j.run(Unknown Source)',
  ].join('\n');
  const crash = classifyCrash(out, 1);
  assert.equal(crash.headline, 'java.lang.RuntimeException: level load failed');
});

// —— 致命死因专类（2026-11-07 用户拍板；只对签名死因块顶层 header 归类，unknown 只留未分类）
test('专类：NPE（含游戏帧 = 致命，如 indev L339 sndManager 路径）→ null-pointer', () => {
  const out = [
    'java.lang.NullPointerException',
    '\tat net.minecraft.client.sound.SoundManager.setListener(SoundManager.java:88)',
    '\tat net.minecraft.client.Minecraft.run(Minecraft.java:339)',
  ].join('\n');
  assert.equal(classifyCrash(out, 0).category, 'null-pointer');
});

test('专类：TimSort 契约消息特判 → tim-sort；同型 IAE 其他消息不配专类（留 unknown）', () => {
  const tim = [
    'java.lang.IllegalArgumentException: Comparison method violates its general contract!',
    '\tat java.util.TimSort.mergeHi(TimSort.java:886)',
    '\tat net.minecraft.client.renderer.RenderGlobal.a(RenderGlobal.java:123)',
  ].join('\n');
  assert.equal(classifyCrash(tim, 1).category, 'tim-sort');
  assert.match(classifyCrash(tim, 1).stack, /TimSort\.mergeHi/);
  const other = [
    'java.lang.IllegalArgumentException: width is 0',
    '\tat net.minecraft.client.X.a(X.java:1)',
  ].join('\n');
  assert.equal(classifyCrash(other, 1).category, 'unknown');
});

test('专类：数组越界（Array/String/裸 IndexOutOfBounds 三形态）→ index-out-of-bounds', () => {
  for (const cls of ['ArrayIndexOutOfBoundsException', 'StringIndexOutOfBoundsException', 'IndexOutOfBoundsException']) {
    const out = [`java.lang.${cls}: 42`, '\tat net.minecraft.src.World.b(World.java:423)'].join('\n');
    assert.equal(classifyCrash(out, 1).category, 'index-out-of-bounds', cls);
  }
});

test('专类：IllegalStateException（状态冲突/重复初始化）→ illegal-state', () => {
  const out = [
    'Exception in thread "main" java.lang.IllegalStateException: Timer already registered',
    '\tat org.lwjgl.util.timer.GTimer.initialize(GTimer.java:73)',
  ].join('\n');
  assert.equal(classifyCrash(out, 1).category, 'illegal-state');
});

test('paulscode 音频引擎线程 NPE 压尾（全帧无游戏代码）→ 非致命噪音不报（indev-20100223 用户点名）', () => {
  const out = [
    '[12:00:00] [info] game running fine',
    'java.lang.NullPointerException',
    '\tat paulscode.sound.SoundSystem$CommandThread.run(SourceFile:877)',
    '\tat java.lang.Thread.run(Thread.java:745)',
  ].join('\n');
  assert.equal(classifyCrash(out, 0), null);
  assert.equal(classifyStopped(out), null);
});
