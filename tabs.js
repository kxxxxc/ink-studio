/* Ink Studio — top-level tabs: 传图工具 / 模式卡片 / 字模 / OTA 工具. */
(function () {
  'use strict';

  const TABS = ['image', 'cards', 'fonts', 'ota'];
  const buttons = Array.from(document.querySelectorAll('.app-tab'));
  const pages = {
    image: document.getElementById('app'),
    cards: document.getElementById('pageCards'),
    fonts: document.getElementById('pageFonts'),
    ota: document.getElementById('pageOta'),
  };
  const debugButton = document.getElementById('debugBtn');
  let current = '';

  function show(name, updateHash = true) {
    if (!TABS.includes(name)) name = 'image';
    if (name === current) return;
    current = name;
    for (const tab of TABS) {
      const active = tab === name;
      pages[tab].hidden = !active;
      const button = buttons.find((item) => item.dataset.tab === tab);
      if (button) {
        button.classList.toggle('active', active);
        button.setAttribute('aria-selected', String(active));
        button.tabIndex = active ? 0 : -1;
      }
    }
    // 手动模式只属于传图页；离开时保留状态，回来时 fitView 会重新算画布尺寸。
    debugButton.hidden = name !== 'image';
    document.body.dataset.tab = name;
    if (updateHash && location.hash !== '#' + name) {
      history.replaceState(null, '', '#' + name);
    }
    window.dispatchEvent(new CustomEvent('ink:tab', { detail: { tab: name } }));
  }

  for (const button of buttons) {
    button.addEventListener('click', () => show(button.dataset.tab));
    button.addEventListener('keydown', (event) => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      event.preventDefault();
      const index = TABS.indexOf(button.dataset.tab);
      const next = (index + (event.key === 'ArrowRight' ? 1 : -1) + TABS.length) % TABS.length;
      show(TABS[next]);
      buttons.find((item) => item.dataset.tab === TABS[next])?.focus();
    });
  }

  window.addEventListener('hashchange', () => show(location.hash.slice(1), false));
  window.INK_TABS = { show, current: () => current };
  show(location.hash.slice(1) || 'image', false);
})();
