/* 主题初始化。
 *
 * ⚠️ 必须放在 <head> 里、**在 styles.css 之前**同步执行。
 * 放到 app.js 里会先按默认主题画一帧再切过去 —— 用户看到的是"闪一下"。
 *
 * 独立成文件而不是内联 <script>，是因为 index.html 的 CSP 是 script-src 'self'，
 * 内联脚本会被拦掉。
 */
(function () {
  var t = null;
  try {
    t = localStorage.getItem('mcm-theme');
  } catch (e) {
    /* localStorage 不可用（极少见）时忽略，走下面的系统偏好 */
  }
  if (t !== 'light' && t !== 'dark') {
    // 没存过就跟系统走
    try {
      t = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches
        ? 'light' : 'dark';
    } catch (e) {
      t = 'dark';
    }
  }
  document.documentElement.dataset.theme = t;
})();
