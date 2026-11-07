/* ==========================================================================
   Счёт для организации: форма заявки (MCP:RSV Server и MCP:RSV Data Pro).

   Цены Server — pricing-data.js (общий прайс сайта); цены Data Pro и скидки владельцам
   Server — из скрипта лицензий Data Pro (action=pricing). Поиск организации по ИНН / УНП /
   БИН и приём заявки — скрипт лицензий Server (company-lookup, invoice-request): суммы,
   скидка и подарок по акции там пересчитываются заново; страница показывает их заранее.
   Акция — по времени заявки (promo-info, через общий блок акции promo.js): в дни акции +N мес. к годовым лицензиям Server,
   до начала — честная строка «начнётся… сейчас не добавляется».

   Ссылка для клиентов: invoice.html; invoice.html?product=datapro — сразу строка Data Pro.
   ========================================================================== */
(function () {
  'use strict';

  var GAS = PRICING_GAS;
  var DP_PRICING_URL = 'https://script.google.com/macros/s/AKfycbzJCqQFix-GphO6cZwF8sGDdhlMIogDB5EhTyjGmlc2EVfsBe5Iz_7ph4oWRiRs6bzX/exec?action=pricing';
  var DP_SITE = 'https://prepod2003.github.io/rsv-data-pro/';
  var OFFER = { SRV: 'terms.html', DP: 'https://prepod2003.github.io/rsv-data-pro/terms.html' };
  var NAMES = { SRV: 'MCP:RSV Server', DP: 'MCP:RSV Data Pro' };
  var TIERS = { SRV: { ANL: 'Аналитик', DEV: 'Разработчик', ARC: 'Архитектор', PRO: 'Архитектор Про' },
                DP: { AGENT: 'Старт', ASSISTANT: 'Бизнес' } };
  var PERIODS = { '1M': '1 месяц', '3M': '3 месяца', '6M': '6 месяцев', '1Y': '1 год', 'LT': 'навсегда' };
  var SRV_FULL = { ANL: 'ANALYST', DEV: 'DEVELOPER', ARC: 'ARCHITECT', PRO: 'ARCHITECT_PRO' };
  var PAID_FROM = ['Беларусь'];
  var REG = { 'Беларусь': { code: 'BY', digits: 9, label: 'УНП', src: 'Данные — из Единого госрегистра Беларуси.', addr: '220004, г. Минск, ул. …' },
              'Казахстан': { code: 'KZ', digits: 12, label: 'БИН', src: 'Данные — Бюро национальной статистики Казахстана.', addr: '050000, г. Алматы, ул. …' } };
  var MAX_FILE = 5 * 1024 * 1024;
  var MONTH_GEN = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];

  var $ = function (id) { return document.getElementById(id); };
  var fmt = function (n) { return Math.round(n).toLocaleString('ru-RU') + ' ₽'; };
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }

  // ---------- состояние ----------
  var dp = null, dpState = 'loading';          // прайс Data Pro: loading | ok | fail
  var promo = null, skew = 0;                   // акция (promo-info) и поправка часов
  var kind = 'ru', edo = '', file = null;
  var ruFound = null, foreignFound = null;      // найденные организации { name, address, … }
  var initial = /[?&]product=datapro\b/.test(location.search)
    ? { p: 'DP', t: 'ASSISTANT', per: '1Y', q: 1 } : { p: 'SRV', t: 'ARC', per: '1Y', q: 1 };
  var lines = [initial];

  // ---------- цены и скидки ----------
  function unitPrice(l) {
    if (l.p === 'SRV') { var d = PRICING_DATA[l.per]; return d && d[l.t] != null ? d[l.t] : null; }
    if (!dp || !dp.tiers || !dp.tiers[l.t]) return null;
    var x = dp.tiers[l.t][l.per === 'LT' ? 'PERPETUAL' : l.per];
    return x && x.price > 0 ? x.price : null;
  }
  function periodsFor(l) {
    var o = {};
    Object.keys(PERIODS).forEach(function (k) {
      if (l.p === 'SRV' ? (PRICING_DATA[k] && PRICING_DATA[k][l.t] != null) : (!dp || unitPrice({ p: 'DP', t: l.t, per: k }) != null)) o[k] = PERIODS[k];
    });
    return o;
  }
  function discounts() { return (dp && dp.discounts) || { DEVELOPER: 30, ARCHITECT: 40, ARCHITECT_PRO: 50 }; }
  /* Скидка на Data Pro: по коду Server или по Server в этой заявке — бо́льшая. */
  function dpDiscount() {
    var ds = discounts(), best = 0, from = '';
    var m = /^ACT-(DEV|ARC|PRO)-/.exec($('srvcode').value.trim().toUpperCase());
    if (m && ds[SRV_FULL[m[1]]] > best) { best = ds[SRV_FULL[m[1]]]; from = 'по коду лицензии Server'; }
    lines.forEach(function (l) {
      if (l.p === 'SRV' && (ds[SRV_FULL[l.t]] || 0) > best) { best = ds[SRV_FULL[l.t]]; from = 'MCP:RSV Server «' + TIERS.SRV[l.t] + '» в этой заявке'; }
    });
    return { pct: best, from: from };
  }
  function lineSum(l, d) {
    var u = unitPrice(l);
    if (u == null) return null;
    var base = u * l.q, pct = l.p === 'DP' ? d.pct : 0;
    return { base: base, sum: Math.round(base * (100 - pct) / 100), pct: pct };
  }

  // ---------- акция ----------
  function now() { return Date.now() + skew; }
  function phase() {
    if (!promo) return '';
    var t = now();
    if (t >= promo.startMs && t < promo.endMs) return 'on';
    if (typeof promo.announceMs === 'number' && t >= promo.announceMs && t < promo.startMs) return 'soon';
    return '';
  }
  function hasGift(l) { return phase() === 'on' && l.p === 'SRV' && promo.tiers.indexOf(l.t + '-' + l.per) !== -1; }
  function giftCount() { return lines.reduce(function (a, l) { return a + (hasGift(l) ? l.q : 0); }, 0); }
  function promoName() { return promo && promo.badge ? 'Акция ' + promo.badge : 'Акция'; }
  function mskDay(ms) { var d = new Date(ms + 3 * 3600e3); return d.getUTCDate() + ' ' + MONTH_GEN[d.getUTCMonth()]; }
  function promoDates() {
    var a = new Date(promo.startMs + 3 * 3600e3), b = new Date(promo.endMs - 1 + 3 * 3600e3);
    return a.getUTCMonth() === b.getUTCMonth()
      ? 'с ' + a.getUTCDate() + ' по ' + b.getUTCDate() + ' ' + MONTH_GEN[b.getUTCMonth()]
      : 'с ' + mskDay(promo.startMs) + ' по ' + mskDay(promo.endMs - 1);
  }
  function monthsWord(n) {
    var a = n % 10, b = n % 100;
    return n + ' ' + (a === 1 && b !== 11 ? 'месяц' : a >= 2 && a <= 4 && (b < 12 || b > 14) ? 'месяца' : 'месяцев');
  }

  // ---------- отрисовка ----------
  function options(obj, sel) {
    return Object.keys(obj).map(function (k) { return '<option value="' + k + '"' + (k === sel ? ' selected' : '') + '>' + obj[k] + '</option>'; }).join('');
  }

  function render() {
    var d = dpDiscount();
    $('lines').innerHTML = lines.map(function (l, i) {
      var per = periodsFor(l);
      if (!per[l.per]) l.per = Object.keys(per)[0] || '1Y';
      var s = lineSum(l, d);
      return '<div class="line' + (lines.length > 1 ? ' removable' : '') + '" data-i="' + i + '">' +
        '<div class="f f-prod"><label>Продукт</label><select data-k="p" aria-label="Продукт">' + options(NAMES, l.p) + '</select></div>' +
        '<div class="f f-tier"><label>Тариф</label><select data-k="t" aria-label="Тариф">' + options(TIERS[l.p], l.t) + '</select></div>' +
        '<div class="f"><label class="lbl-gift">Срок' + (hasGift(l) ? ' <span class="gift" title="Подарок по акции: +' + promo.months +
          ' мес. к каждой лицензии">+' + promo.months + ' мес.</span>' : '') + '</label><select data-k="per" aria-label="Срок">' + options(per, l.per) + '</select></div>' +
        '<div class="f"><label>Мест</label><div class="qty"><button type="button" data-q="-1" aria-label="Меньше">−</button>' +
          '<input data-k="q" value="' + l.q + '" inputmode="numeric" aria-label="Количество мест"><button type="button" data-q="1" aria-label="Больше">+</button></div></div>' +
        '<div class="sum">' + (s ? (s.pct ? '<s>' + fmt(s.base) + '</s>' : '') + fmt(s.sum) : '—') + '</div>' +
        '<button type="button" class="x" data-del aria-label="Удалить строку"' + (lines.length < 2 ? ' hidden' : '') + '>×</button>' +
      '</div>';
    }).join('');

    var total = 0, rows = '', unknown = false;
    lines.forEach(function (l) {
      var s = lineSum(l, d);
      if (!s) { unknown = true; return; }
      total += s.sum;
      rows += '<div><span>' + NAMES[l.p] + ' «' + TIERS[l.p][l.t] + '», ' + (PERIODS[l.per] + ' × ' + l.q).replace(/ /g, ' ') +
        '</span><span>' + fmt(s.base) + '</span></div>';
    });
    var hasDp = lines.some(function (l) { return l.p === 'DP'; });
    if (hasDp && d.pct && !unknown) {
      var save = lines.reduce(function (a, l) { var s = lineSum(l, d); return a + (s ? s.base - s.sum : 0); }, 0);
      rows += '<div class="disc"><span>Скидка на Data Pro ' + d.pct + '&nbsp;% (' + esc(d.from) + ')</span><span>−' + fmt(save) + '</span></div>';
    }
    if (hasDp && dpState === 'loading') rows += '<div class="load-row">Загружаем цены MCP:RSV Data Pro…</div>';
    if (hasDp && dpState === 'fail') rows += '<div class="err-row">Цены MCP:RSV Data Pro не загрузились. Обновите страницу или напишите нам: Telegram @Prepod2003.</div>';
    var ph = phase(), gc = giftCount();
    if (ph === 'soon' && lines.some(function (l) { return l.p === 'SRV'; })) {
      rows += '<div class="soon-row"><b>' + esc(promoName()) + ' начнётся ' + mskDay(promo.startMs) + ':</b> заявки, поданные ' + promoDates() +
        ', получат +' + monthsWord(promo.months) + ' к годовым лицензиям MCP:RSV Server. Сейчас подарок не добавляется.</div>';
    }
    if (gc) {
      rows += '<div class="gift-row"><b>Подарок по акции' + (promo.badge ? ' ' + esc(promo.badge) : '') + ':</b> +' + monthsWord(promo.months) + ' к ' +
        (gc === 1 ? 'годовой лицензии' : 'каждой из ' + gc + ' годовых лицензий') + ' MCP:RSV Server. Заявка подана ' + promoDates() +
        ' — подарок сохранится, даже если счёт будет оплачен позже.</div>';
    }
    $('tl').innerHTML = rows;
    $('sum').textContent = unknown ? '—' : fmt(total);
    crossSell(d);
    offers();
  }

  /* Согласие — с офертами продуктов из заявки. */
  function offers() {
    var used = ['SRV', 'DP'].filter(function (p) { return lines.some(function (l) { return l.p === p; }); });
    var link = function (p) { return '<a href="' + OFFER[p] + '" target="_blank" rel="noopener">' + NAMES[p] + '</a>'; };
    $('c1-text').innerHTML = used.length > 1
      ? 'Принимаю условия публичных оферт ' + link('SRV') + ' и ' + link('DP')
      : 'Принимаю условия публичной оферты ' + link(used[0]);
  }

  /* Подсказка о скидке на Data Pro — по составу заявки. */
  function crossSell(d) {
    var hasSrv = lines.some(function (l) { return l.p === 'SRV'; });
    var hasDp = lines.some(function (l) { return l.p === 'DP'; });
    var ds = discounts(), best = 0, tier = '';
    lines.forEach(function (l) { if (l.p === 'SRV' && (ds[SRV_FULL[l.t]] || 0) >= best) { best = ds[SRV_FULL[l.t]] || 0; tier = TIERS.SRV[l.t]; } });
    $('code-row').hidden = !hasDp;
    $('xsell').hidden = hasDp || !hasSrv;
    if (!hasDp && hasSrv) {
      $('xsell-text').innerHTML = best
        ? 'С MCP:RSV Server вы получаете скидку на MCP:RSV Data Pro — <b>' + best + '&nbsp;%</b> для тарифа «' + esc(tier) + '». ' +
          'Data Pro — работа ИИ-агента с данными живой базы 1С. <a href="' + DP_SITE + '" target="_blank" rel="noopener">Что такое Data Pro →</a>'
        : 'На тарифе «' + esc(tier) + '» скидки на MCP:RSV Data Pro нет. Скидка есть на тарифах «Разработчик» — ' + ds.DEVELOPER + '&nbsp;%, ' +
          '«Архитектор» — ' + ds.ARCHITECT + '&nbsp;%, «Архитектор Про» — ' + ds.ARCHITECT_PRO + '&nbsp;%. ' +
          '<a href="' + DP_SITE + '" target="_blank" rel="noopener">Что такое Data Pro →</a>';
      return;
    }
    if (hasDp && hasSrv && best) {
      $('code-field').hidden = true;
      $('code-row').classList.add('only-note');
      $('code-note-text').innerHTML = 'Скидка на Data Pro <b>' + d.pct + '&nbsp;%</b> уже учтена — в заявке MCP:RSV Server «' + esc(tier) + '».';
      return;
    }
    $('code-field').hidden = false;
    $('code-row').classList.remove('only-note');
    $('code-note-text').innerHTML = 'Владельцам MCP:RSV Server — скидка на Data Pro <span style="white-space:nowrap">' + ds.DEVELOPER + '–' +
      ds.ARCHITECT_PRO + '&nbsp;%</span> (зависит от тарифа Server). <a href="index.html" target="_blank" rel="noopener">Что такое MCP:RSV Server →</a>';
  }

  // ---------- строки покупки ----------
  $('lines').addEventListener('change', function (e) {
    var row = e.target.closest('.line'); if (!row) return;
    var l = lines[+row.getAttribute('data-i')], k = e.target.getAttribute('data-k');
    if (k === 'p') { l.p = e.target.value; l.t = Object.keys(TIERS[l.p])[l.p === 'DP' ? 1 : 2]; }
    else if (k === 'q') l.q = Math.max(1, Math.min(99, parseInt(e.target.value, 10) || 1));
    else if (k) l[k] = e.target.value;
    render();
  });
  $('lines').addEventListener('click', function (e) {
    var row = e.target.closest('.line'); if (!row) return;
    var i = +row.getAttribute('data-i'), q = e.target.getAttribute('data-q');
    if (q) { lines[i].q = Math.max(1, Math.min(99, lines[i].q + +q)); render(); }
    if (e.target.hasAttribute('data-del')) { lines.splice(i, 1); render(); }
  });
  $('add').addEventListener('click', function () { lines.push({ p: 'SRV', t: 'ARC', per: '1Y', q: 1 }); render(); });
  $('xsell-add').addEventListener('click', function () { lines.push({ p: 'DP', t: 'ASSISTANT', per: '1Y', q: 1 }); render(); });
  $('srvcode').addEventListener('input', render);

  // ---------- покупатель: Россия ----------
  function innOk(v) {
    if (!/^\d{10}$|^\d{12}$/.test(v)) return false;
    var n = v.split('').map(Number);
    var c = function (w) { var s = 0; for (var i = 0; i < w.length; i++) s += w[i] * n[i]; return s % 11 % 10; };
    if (v.length === 10) return c([2, 4, 10, 3, 5, 9, 4, 6, 8]) === n[9];
    return c([7, 2, 4, 10, 3, 5, 9, 4, 6, 8]) === n[10] && c([3, 7, 2, 4, 10, 3, 5, 9, 4, 6, 8]) === n[11];
  }
  /* Поиск организации в реестре через скрипт лицензий; reason: no-key | not-found | limit | error. */
  function lookup(country, id, done) {
    fetch(GAS + '?action=company-lookup&country=' + country + '&id=' + encodeURIComponent(id))
      .then(function (r) { return r.json(); })
      .then(function (r) { done(r && r.success ? r : { found: false, reason: 'error' }); })
      .catch(function () { done({ found: false, reason: 'error' }); });
  }
  /* Итог поиска. Не найдено или реестр не ответил — честно об этом и просьба вписать название:
     «номер верный» по одной контрольной сумме не говорит, что это та организация. */
  function showFound(box, nameEl, metaEl, noteEl, r, okNote, miss) {
    box.hidden = false;
    box.classList.toggle('neutral', !r.found);
    box.classList.toggle('miss', !r.found && r.reason === 'not-found');
    if (r.found) {
      nameEl.textContent = r.name;
      metaEl.textContent = [r.kpp ? 'КПП ' + r.kpp : '', r.address, r.head, r.status].filter(Boolean).join(' · ');
      noteEl.textContent = okNote;
    } else {
      var m = r.reason === 'not-found' ? miss.notFound : miss.unknown;
      nameEl.textContent = m[0]; metaEl.textContent = m[1]; noteEl.textContent = '';
    }
  }
  var RU_MISS = {
    notFound: ['Организация с таким ИНН не найдена', 'Проверьте ИНН — возможно, ошибка в цифре. Если ИНН верный (организация зарегистрирована на днях), впишите название ниже.'],
    unknown: ['Не удалось проверить ИНН по реестру', 'Впишите название организации или ФИО предпринимателя ниже — сверим его с ИНН при выставлении счёта.']
  };
  var FOREIGN_MISS = {
    notFound: ['В реестре не найдено', 'Проверьте номер — возможно, ошибка в цифре. Если он верный, впишите название ниже или приложите карточку предприятия.'],
    unknown: ['Не удалось проверить номер по реестру', 'Впишите название организации ниже или приложите карточку предприятия.']
  };
  var innSeq = 0, ruState = 'idle';   // idle | pending | found | none
  function ruNameRow(show) {
    $('ru-name-row').hidden = !show;
    if (!show) { $('ru-name').classList.remove('bad'); document.querySelector('[data-err="ru-name"]').hidden = true; }
  }
  function findInn() {
    var v = $('inn').value.replace(/\D/g, ''); $('inn').value = v;
    $('inn-found').hidden = true; $('kpp-row').hidden = true; ruFound = null; ruState = 'idle'; ruNameRow(false);
    if (!innOk(v)) {
      $('inn-err').textContent = v ? 'В ИНН ошибка — проверьте цифры.' : 'Укажите ИНН — без него счёт не выставить.';
      $('inn-err').hidden = false; return;
    }
    $('inn-err').hidden = true; $('inn').classList.remove('bad');
    $('kpp-row').hidden = v.length !== 10;
    var my = ++innSeq; ruState = 'pending';
    $('f-name').textContent = 'Ищем…'; $('f-meta').textContent = ''; $('f-note').textContent = '';
    $('inn-found').hidden = false; $('inn-found').classList.add('neutral'); $('inn-found').classList.remove('miss');
    lookup('RU', v, function (r) {
      if (my !== innSeq) return;
      ruFound = r.found ? r : null;
      ruState = r.found ? 'found' : 'none';
      showFound($('inn-found'), $('f-name'), $('f-meta'), $('f-note'), r,
        'Данные — из госреестра (ЕГРЮЛ / ЕГРИП). Это ваша организация? Если нет — проверьте ИНН.' +
        (v.length === 10 ? ' Если КПП другой (филиал), укажите его ниже.' : ''), RU_MISS);
      ruNameRow(!r.found);
    });
  }
  $('ru-name').addEventListener('input', function () {
    if (this.value.trim()) { this.classList.remove('bad'); document.querySelector('[data-err="ru-name"]').hidden = true; }
  });
  $('inn-go').addEventListener('click', findInn);
  $('inn').addEventListener('keydown', function (e) { if (e.key === 'Enter') findInn(); });
  $('inn').addEventListener('input', function () { var v = this.value.replace(/\D/g, ''); if (v.length === 10 || v.length === 12) findInn(); });

  // ---------- покупатель: другая страна ----------
  var taxSeq = 0;
  function countryChanged() {
    var c = $('country').value, r = REG[c];
    $('taxno-l').textContent = r ? r.label : 'Налоговый номер';
    $('taxno-fmt').textContent = r ? '— ' + r.digits + ' цифр' : '';
    $('taxno').value = ''; $('taxno').classList.remove('bad');
    $('taxno').setAttribute('inputmode', r ? 'numeric' : 'text');
    $('tax-go').hidden = !r;
    $('pay-warn').hidden = PAID_FROM.indexOf(c) !== -1;
    $('f-found').hidden = true; foreignFound = null; $('tax-err').hidden = true; $('f-manual').hidden = false;
    $('faddr').placeholder = r ? r.addr : 'индекс, город, улица, дом';
    $('drop-tail').textContent = r ? 'С ней не нужно заполнять банковские реквизиты.' : 'Этого достаточно, поля выше и ниже можно не заполнять.';
  }
  function findForeign() {
    var c = $('country').value, r = REG[c];
    if (!r) return;
    var v = $('taxno').value.replace(/\D/g, ''); $('taxno').value = v;
    $('f-found').hidden = true; foreignFound = null; $('f-manual').hidden = false;
    if (v.length !== r.digits) { $('tax-err').textContent = r.label + ' — ' + r.digits + ' цифр. Проверьте номер.'; $('tax-err').hidden = false; return; }
    $('tax-err').hidden = true; $('taxno').classList.remove('bad');
    var my = ++taxSeq;
    $('ff-name').textContent = 'Ищем…'; $('ff-meta').textContent = ''; $('ff-note').textContent = '';
    $('f-found').hidden = false; $('f-found').classList.add('neutral');
    lookup(r.code, v, function (res) {
      if (my !== taxSeq) return;
      foreignFound = res.found ? res : null;
      showFound($('f-found'), $('ff-name'), $('ff-meta'), $('ff-note'), res, r.src + ' Это ваша организация? Если нет — проверьте номер.', FOREIGN_MISS);
      $('f-manual').hidden = !!res.found;   // название и адрес пришли из реестра
    });
  }
  $('country').addEventListener('change', countryChanged);
  $('tax-go').addEventListener('click', findForeign);
  $('taxno').addEventListener('keydown', function (e) { if (e.key === 'Enter') findForeign(); });
  $('taxno').addEventListener('input', function () {
    var r = REG[$('country').value]; if (!r) return;
    var v = this.value.replace(/\D/g, '');
    if (v.length === r.digits) findForeign();
    else if (foreignFound) { $('f-found').hidden = true; foreignFound = null; $('f-manual').hidden = false; }
  });

  // файл карточки предприятия
  $('file').addEventListener('change', function () {
    var f = this.files && this.files[0];
    $('file-err').hidden = true;
    if (!f) { file = null; $('file-name').hidden = true; return; }
    if (f.size > MAX_FILE) {
      file = null; this.value = ''; $('file-name').hidden = true;
      $('file-err').textContent = 'Файл больше 5 МБ — пришлите его на почту prepod2003@yandex.ru.'; $('file-err').hidden = false; return;
    }
    file = f; $('file-name').textContent = '📎 ' + f.name; $('file-name').hidden = false;
  });

  // переключатель «Россия / другая страна»
  document.querySelectorAll('.seg button[data-kind]').forEach(function (b) {
    b.addEventListener('click', function () {
      document.querySelectorAll('.seg button[data-kind]').forEach(function (x) { x.classList.toggle('on', x === b); });
      kind = b.getAttribute('data-kind');
      $('ru-block').hidden = kind !== 'ru'; $('foreign-block').hidden = kind === 'ru';
    });
  });

  // ЭДО
  document.querySelectorAll('.seg.edo button').forEach(function (b) {
    b.addEventListener('click', function () {
      edo = b.getAttribute('data-edo');
      document.querySelectorAll('.seg.edo button').forEach(function (x) { x.classList.toggle('on', x === b); x.setAttribute('aria-checked', x === b ? 'true' : 'false'); });
      document.querySelector('.seg.edo').classList.remove('bad');
      document.querySelector('[data-err="edo"]').hidden = true;
      $('edo-hint').textContent = edo === 'yes' ? 'Акт приёма-передачи прав отправим через ЭДО.' : 'Акт приёма-передачи прав придёт в PDF на почту для счёта.';
    });
  });

  // ---------- проверка и отправка ----------
  function check() {
    var bad = [];
    function mark(id, msg) {
      var e = document.querySelector('[data-err="' + id + '"]');
      $(id).classList.toggle('bad', !!msg);
      if (e) { e.textContent = msg || ''; e.hidden = !msg; }
      if (msg) bad.push($(id));
    }
    if (kind === 'ru') {
      var v = $('inn').value.replace(/\D/g, '');
      if (!innOk(v)) {
        $('inn').classList.add('bad');
        $('inn-err').textContent = v ? 'В ИНН ошибка — проверьте цифры.' : 'Укажите ИНН — без него счёт не выставить.';
        $('inn-err').hidden = false; bad.push($('inn'));
      } else if (ruState === 'idle') {
        findInn();
        $('send-err').textContent = 'Проверяем ИНН по реестру — посмотрите, та ли это организация, и отправьте ещё раз.'; $('send-err').hidden = false;
        bad.push($('inn'));
      } else if (ruState === 'pending') {
        $('send-err').textContent = 'Подождите секунду — проверяем ИНН по реестру.'; $('send-err').hidden = false;
        bad.push($('inn'));
      } else if (ruState === 'none') {
        mark('ru-name', $('ru-name').value.trim() ? '' : 'Впишите название организации или ФИО предпринимателя — проверить ИНН по реестру не удалось.');
      }
    } else {
      var tv = $('taxno').value.trim(), rr = REG[$('country').value];
      var tmsg = !tv ? 'Укажите ' + $('taxno-l').textContent + ' — без него счёт не выставить.'
        : (rr && tv.replace(/\D/g, '').length !== rr.digits ? rr.label + ' — ' + rr.digits + ' цифр. Проверьте номер.' : '');
      $('taxno').classList.toggle('bad', !!tmsg);
      if (tmsg) { $('tax-err').textContent = tmsg; $('tax-err').hidden = false; bad.push($('taxno')); }
      if (!foreignFound && !$('fname').value.trim() && !file) {
        $('fname').classList.add('bad');
        if (!tmsg) { $('tax-err').textContent = 'Укажите название организации или приложите карточку предприятия.'; $('tax-err').hidden = false; }
        bad.push($('fname'));
      } else $('fname').classList.remove('bad');
    }
    mark('email', /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test($('email').value.trim()) ? '' : 'Укажите почту — на неё придут счёт и ключи.');
    mark('person', $('person').value.trim() ? '' : 'Укажите, с кем связаться.');
    mark('phone', $('phone').value.trim() ? '' : 'Укажите телефон или Telegram.');
    if (!edo) {
      document.querySelector('.seg.edo').classList.add('bad');
      var ee = document.querySelector('[data-err="edo"]'); ee.textContent = 'Выберите «Да» или «Нет» — от этого зависит, как придёт акт.'; ee.hidden = false;
      bad.push(document.querySelector('.seg.edo button'));
    }
    var ce = document.querySelector('[data-err="consent"]');
    if (!$('c1').checked || !$('c2').checked) { ce.textContent = 'Отметьте согласие с офертой и на обработку персональных данных.'; ce.hidden = false; bad.push($('c1')); }
    else ce.hidden = true;
    if (lines.some(function (l) { return l.p === 'DP'; }) && dpState !== 'ok') {
      $('send-err').textContent = 'Цены MCP:RSV Data Pro ещё не загрузились — подождите или обновите страницу.'; $('send-err').hidden = false;
      bad.push($('send'));
    }
    if (bad.length) { bad[0].scrollIntoView({ block: 'center', behavior: 'smooth' }); bad[0].focus({ preventScroll: true }); }
    return !bad.length;
  }
  ['email', 'person', 'phone'].forEach(function (id) { $(id).addEventListener('input', function () { if (this.classList.contains('bad')) check(); }); });

  function readFile(f) {
    return new Promise(function (resolve, reject) {
      var r = new FileReader();
      r.onload = function () { resolve(String(r.result).split(',')[1] || ''); };
      r.onerror = function () { reject(new Error('read')); };
      r.readAsDataURL(f);
    });
  }

  $('send').addEventListener('click', function () {
    $('send-err').hidden = true;
    if (!check()) return;
    var btn = $('send'); btn.disabled = true; btn.textContent = 'Отправляем…';
    var payload = {
      action: 'invoice-request',
      buyer: kind === 'ru'
        ? { kind: 'ru', inn: $('inn').value.replace(/\D/g, ''), kpp: $('kpp').value.trim(), postAddress: $('ru-addr').value.trim(),
            name: ruFound ? '' : $('ru-name').value.trim(),
            found: ruFound ? { name: ruFound.name, address: ruFound.address } : null }
        : { kind: 'foreign', country: $('country').value, taxno: $('taxno').value.trim(), name: $('fname').value.trim(), address: $('faddr').value.trim(),
            iban: $('iban').value.trim(), swift: $('swift').value.trim(), bankName: $('bank').value.trim(),
            found: foreignFound ? { name: foreignFound.name, address: foreignFound.address } : null },
      lines: lines.map(function (l) { return { product: l.p, tier: l.t, period: l.per, qty: l.q, unitRub: unitPrice(l) || 0 }; }),
      srvCode: $('srvcode').value.trim(),
      contact: { email: $('email').value.trim(), person: $('person').value.trim(), phone: $('phone').value.trim(), position: $('position').value.trim() },
      edo: edo, comment: $('comment').value.trim(), hp: $('website').value
    };
    var withFile = kind === 'foreign' && file
      ? readFile(file).then(function (b64) { payload.file = { name: file.name, mime: file.type, base64: b64 }; })
      : Promise.resolve();
    withFile
      .then(function () { return fetch(GAS, { method: 'POST', body: JSON.stringify(payload) }); })
      .then(function (r) { return r.json(); })
      .then(function (r) {
        if (!r || !r.success) throw new Error((r && r.message) || 'Не получилось отправить заявку.');
        $('d-mail').textContent = payload.contact.email;
        $('d-act').textContent = edo === 'yes' ? 'Акт приёма-передачи прав пришлём через ЭДО.' : 'Акт приёма-передачи прав пришлём в PDF на эту почту.';
        $('d-gift').hidden = !r.giftCount;
        $('d-gift').textContent = r.giftCount ? 'Подарок по акции: +' + monthsWord(r.giftMonths) + ' к годовым лицензиям MCP:RSV Server — добавим при выпуске кодов.' : '';
        $('d-pay').hidden = !r.payCheck;
        $('d-pay').textContent = r.payCheck ? 'Перед оплатой уточните в своём банке, проходит ли перевод в российских рублях в банк в России.' : '';
        $('form-view').hidden = true; $('done-view').hidden = false; window.scrollTo({ top: 0 });
      })
      .catch(function (e) {
        btn.disabled = false; btn.textContent = 'Запросить счёт';
        $('send-err').textContent = (e && e.message && !/fetch|network|Failed/i.test(e.message)) ? e.message
          : 'Не получилось отправить заявку. Проверьте интернет и попробуйте ещё раз или напишите нам: Telegram @Prepod2003, prepod2003@yandex.ru.';
        $('send-err').hidden = false;
      });
  });

  // ---------- загрузка: прайс Data Pro и акция ----------
  fetch(DP_PRICING_URL).then(function (r) { return r.json(); })
    .then(function (d) { if (d && d.ok && d.tiers) { dp = d; dpState = 'ok'; } else dpState = 'fail'; render(); })
    .catch(function () { dpState = 'fail'; render(); });

  countryChanged();
  render();

  /* Акция: данные берутся у общего блока акции сайта (promo.js — полоса, значок, карточка;
     там же просмотр на своём компьютере ?promo-preview). Без него — свой запрос. */
  function takePromo(d, sk) {
    if (d && d.success && typeof d.startMs === 'number' && typeof d.endMs === 'number' && d.tiers && d.months > 0) {
      promo = d; skew = sk || 0; render();
    }
  }
  if (window.RsvPromo && RsvPromo.onInfo) {
    RsvPromo.onInfo(takePromo);
    /* «Выбрать →» в полосе акции: первая строка Server — на годовой срок, прокрутка к составу заявки. */
    RsvPromo.setOfferHandler(function (period) {
      var l = lines.filter(function (x) { return x.p === 'SRV'; })[0];
      if (!l) { l = { p: 'SRV', t: 'ARC', per: period, q: 1 }; lines.unshift(l); }
      if (periodsFor(l)[period]) l.per = period;
      render();
      $('s2').scrollIntoView({ block: 'start', behavior: 'smooth' });
    });
  } else {
    var t0 = Date.now();
    fetch(GAS + '?action=promo-info').then(function (r) { return r.json(); })
      .then(function (d) { takePromo(d, typeof d.now === 'number' ? d.now - t0 : 0); })
      .catch(function () { /* без акции */ });
  }
})();
