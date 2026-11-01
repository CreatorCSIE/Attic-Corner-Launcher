import { createApp } from 'vue';
import './styles/tokens.css';
import './styles/base.css';
import App from './App.vue';
import { useCrash } from './composables/useCrash';

// 渲染层错误采集：window 监听全局挂（控制台窗也上报）；
// Vue 组件树内异常走 errorHandler（否则被 Vue 吞进 console，不到 window.onerror）。
const crash = useCrash();
crash.start();

const app = createApp(App);
app.config.errorHandler = (err, _instance, info) => {
  console.error(err);
  crash.captureVueError(err, info);
};
app.mount('#app');
