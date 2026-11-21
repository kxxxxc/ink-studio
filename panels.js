/* Panel dimensions and color modes from the Waveshare Arduino examples. */
(function () {
  'use strict';
  const modes = {
    bw: { label: '黑白', bits: 1, colors: ['#000000', '#ffffff'], inks: ['黑', '白'] },
    bwr: { label: '黑白红', bits: 1, colors: ['#000000', '#ffffff', '#c80000'], inks: ['黑', '白', '红'] },
    bwy: { label: '黑白黄', bits: 1, colors: ['#000000', '#ffffff', '#edbd12'], inks: ['黑', '白', '黄'] },
    gray4: { label: '四灰阶', bits: 2, colors: ['#000000', '#ffffff', '#555555', '#aaaaaa'], inks: ['黑', '白', '深灰', '浅灰'] },
    seven: { label: '七色', bits: 4, colors: ['#000000', '#ffffff', '#2e863a', '#1c469e', '#c80000', '#edbd12', '#e87924'], inks: ['黑', '白', '绿', '蓝', '红', '黄', '橙'] },
  };

  const panels = [
    ['800x480', 800, 480, 'bwr', '7.5″ TLSR8359'],
    ['400x300', 400, 300, 'bwr', '4.2″ 通用'],
    ['296x128', 296, 128, 'bwr', '2.9″ 横屏'],
    ['128x296', 128, 296, 'bwr', '2.9″ 通用'],
    ['epd1in02d', 80, 128, 'bw'],
    ['epd1in54', 200, 200, 'bw'],
    ['epd1in54_V2', 200, 200, 'bw'],
    ['epd1in54b', 200, 200, 'bwr'],
    ['epd1in54b_V2', 200, 200, 'bwr'],
    ['epd1in54c', 152, 152, 'bwy'],
    ['epd2in13', 128, 250, 'bw'],
    ['epd2in13_V2', 122, 250, 'bw'],
    ['epd2in13b_V3', 104, 212, 'bwr'],
    ['epd2in13bc', 104, 212, 'bwr bwy'],
    ['epd2in13d', 104, 212, 'bw'],
    ['epd2in66', 152, 296, 'bw'],
    ['epd2in7', 176, 264, 'bw gray4'],
    ['epd2in7b', 176, 264, 'bwr'],
    ['epd2in9', 128, 296, 'bw'],
    ['epd2in9b_V2', 128, 296, 'bwr'],
    ['epd2in9bc', 128, 296, 'bwr bwy'],
    ['epd2in9d', 128, 296, 'bw'],
    ['epd3in7', 480, 280, 'bw'],
    ['epd4in2', 400, 300, 'bw gray4'],
    ['epd4in2bc', 400, 300, 'bwr bwy'],
    ['epd5in65f', 600, 448, 'seven'],
    ['epd5in83', 600, 448, 'bw'],
    ['epd5in83b_V2', 648, 480, 'bwr'],
    ['epd5in83bc', 600, 448, 'bwr bwy'],
    ['epd7in5', 640, 384, 'bw'],
    ['epd7in5_HD', 880, 528, 'bw'],
    ['epd7in5_V2', 800, 480, 'bw'],
    ['epd7in5b_HD', 880, 528, 'bwr'],
    ['epd7in5bc', 640, 384, 'bwr bwy'],
    ['epd7in5bc_V2', 800, 480, 'bwr bwy'],
  ].map(([id, w, h, supported, name = id]) => ({ id, name, w, h, modes: supported.split(' ') }));

  window.INK_PANELS = { modes, panels };
})();
