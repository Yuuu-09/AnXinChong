// Keep startup independent of the deployment manifest so import failures remain visible.
if (window.location.protocol !== 'file:') {
  void import('./bootstrap').catch((error: unknown) => {
    const heading = document.getElementById('startup-heading');
    const message = document.getElementById('startup-message');
    const retry = document.getElementById('startup-retry');
    if (heading) heading.textContent = '安心充启动失败';
    if (message)
      message.textContent = `页面资源或部署配置加载失败：${error instanceof Error ? error.message : String(error)}。请检查本地服务和部署配置后重试。`;
    if (retry) {
      retry.hidden = false;
      retry.onclick = () => window.location.reload();
    }
  });
}

export {};
