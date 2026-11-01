'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { classifyCrash, watchdogWindowClass } = require('../dist/index.js');

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

test('未命中规则 → unknown，headline 取末行', () => {
  const crash = classifyCrash('some noise\nweird failure', 2);
  assert.equal(crash.category, 'unknown');
  assert.equal(crash.headline, 'weird failure');
});
