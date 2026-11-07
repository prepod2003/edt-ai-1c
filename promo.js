/* ==========================================================================
   Акция с бонусными месяцами на сайте: полоса над меню, значок у края экрана
   с карточкой акции, метки и подсказки в ценах, блоки в окнах покупки,
   продления и смены тарифа.

   Включается и выключается скриптом лицензий: запрос promo-info отдаёт даты
   акции и анонса, число месяцев, тарифы и надпись значка — по тем же настройкам,
   по которым выдаётся подарок; на странице их нет. Два состояния:
     «скоро» — анонс до начала: значок, полоса и карточка со счётчиком «до начала»;
               подарок нигде не обещается, в окнах — «сейчас подарок не добавляется»;
     «идёт»  — счётчик «до конца», метки и подсказки в ценах и окнах.
   Смена состояний — сама, по часам (с поправкой на время сервера).
   Нет ответа, анонс выключен или акция кончилась — на странице ничего нет.

   Страница с ценами вызывает RsvPromo.refreshPricing / refreshBuy /
   refreshUpgrade; до ответа скрипта они ничего не делают.
   ========================================================================== */
(function () {
  'use strict';

  var GAS = (typeof PRICING_GAS !== 'undefined') ? PRICING_GAS
    : 'https://script.google.com/macros/s/AKfycbzXuSR6nMP7wDIW9tQthJyGBbF7B9BI4hId4z-Npo8PRkMcH_B798HBXOW0cNaWdjInWw/exec';
  var CACHE_KEY = 'rsvPromoInfo';
  var CACHE_TTL = 10 * 60 * 1000;
  var SEEN_KEY = 'rsvPromoSeen-';       // + состояние: карточка уже раскрывалась сама в этом визите
  var HIDE_KEY = 'rsvPromoBadgeHidden'; // посетитель скрыл значок
  var STRIP_KEY = 'rsvPromoStripClosed-'; // + состояние: начало акции снова показывает полосу
  var MSK = 3 * 60 * 60 * 1000;
  var PERIOD_MONTHS = { '1M': 1, '3M': 3, '6M': 6, '1Y': 12 };
  var PERIOD_NAMES = { '1M': '1 месяц', '3M': '3 месяца', '6M': '6 месяцев', '1Y': '1 год' };
  var PERIOD_ON = { '1M': 'на месяц', '3M': 'на 3 месяца', '6M': 'на полгода', '1Y': 'на год' };
  var MONTH_GEN = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа',
    'сентября', 'октября', 'ноября', 'декабря'];
  var GIFT_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="8" width="18" height="4" rx="1"/>' +
    '<path d="M12 8v13"/><path d="M19 12v7a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-7"/>' +
    '<path d="M7.5 8a2.5 2.5 0 0 1 0-5C10 3 12 8 12 8s2-5 4.5-5a2.5 2.5 0 0 1 0 5"/></svg>';

  var info = null;     // ответ promo-info
  var skew = 0;        // поправка часов посетителя по времени сервера
  var ui = null;       // элементы значка, карточки и полосы
  var autoTimer = null;
  var ticker = null;

  // ---------- мелочи ----------
  function sget(k) { try { return sessionStorage.getItem(k); } catch (e) { return null; } }
  function sset(k, v) { try { sessionStorage.setItem(k, v); } catch (e) { /* без памяти визита — тоже работает */ } }
  function now() { return Date.now() + skew; }
  function fmt(n) { return Math.round(n).toLocaleString('ru-RU'); }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function plural(n, one, few, many) {
    var a = n % 10, b = n % 100;
    if (a === 1 && b !== 11) return n + ' ' + one;
    if (a >= 2 && a <= 4 && (b < 12 || b > 14)) return n + ' ' + few;
    return n + ' ' + many;
  }
  function monthsWord(n) { return plural(n, 'месяц', 'месяца', 'месяцев'); }
  /* 'on' — акция идёт; 'soon' — анонс до начала; '' — ничего не показывать. */
  function phase() {
    if (!info) return '';
    var t = now();
    if (t >= info.startMs && t < info.endMs) return 'on';
    if (typeof info.announceMs === 'number' && t >= info.announceMs && t < info.startMs) return 'soon';
    return '';
  }
  function active() { return phase() === 'on'; }
  function badgeText() { return info.badge || ('+' + info.months + ' мес.'); }
  function promoName() { return info.badge ? 'Акция ' + info.badge : 'Акция'; }
  function hasPromo(tier, period) { return !!info && info.tiers.indexOf(tier + '-' + period) !== -1; }
  function anyHasPeriod(period) {
    return !!info && info.tiers.some(function (t) { return t.slice(-period.length - 1) === '-' + period; });
  }
  function bestPeriod(tier) {
    var order = ['1Y', '6M', '3M', '1M'];
    for (var i = 0; i < order.length; i++) if (hasPromo(tier, order[i])) return order[i];
    return '';
  }
  function promoPeriods() {
    return ['1M', '3M', '6M', '1Y'].filter(anyHasPeriod);
  }
  /* «Годовой тариф» — для акции на год; иначе перечень сроков. */
  function offerWhat() {
    var p = promoPeriods();
    if (p.length === 1 && p[0] === '1Y') return 'Годовой тариф';
    return 'Тариф ' + p.map(function (x) { return PERIOD_ON[x]; }).join(', ');
  }
  function datesText() {
    var a = new Date(info.startMs + MSK), b = new Date(info.endMs - 1 + MSK);
    var am = a.getUTCMonth(), bm = b.getUTCMonth();
    return am === bm
      ? a.getUTCDate() + '–' + b.getUTCDate() + ' ' + MONTH_GEN[bm]
      : a.getUTCDate() + ' ' + MONTH_GEN[am] + ' – ' + b.getUTCDate() + ' ' + MONTH_GEN[bm];
  }
  function dayMonth(ms) { var d = new Date(ms + MSK); return d.getUTCDate() + ' ' + MONTH_GEN[d.getUTCMonth()]; }
  /* «с 9 по 13 ноября» */
  function fromToText() {
    var a = new Date(info.startMs + MSK), b = new Date(info.endMs - 1 + MSK);
    return a.getUTCMonth() === b.getUTCMonth()
      ? 'с ' + a.getUTCDate() + ' по ' + b.getUTCDate() + ' ' + MONTH_GEN[b.getUTCMonth()]
      : 'с ' + dayMonth(info.startMs) + ' по ' + dayMonth(info.endMs - 1);
  }
  /* «4 дня 11 часов»; в последние сутки — «11 часов 59 минут»; в последний час — минуты.
     До начала акции считается время до начала, во время акции — до конца. */
  function leftText() {
    var ms = Math.max(0, (phase() === 'soon' ? info.startMs : info.endMs) - now());
    var d = Math.floor(ms / 864e5), h = Math.floor(ms % 864e5 / 36e5), m = Math.floor(ms % 36e5 / 6e4);
    var D = plural(d, 'день', 'дня', 'дней'), H = plural(h, 'час', 'часа', 'часов'), M = plural(m, 'минута', 'минуты', 'минут');
    if (d) return h ? D + ' ' + H : D;
    if (h) return m ? H + ' ' + M : H;
    return M;
  }
  function isPhone() { return window.matchMedia && window.matchMedia('(max-width: 760px)').matches; }
  function el(tag, cls, html) { var e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; }

  // ---------- переход к годовому тарифу ----------
  function switchPeriod(period) {
    var btn = document.querySelector('#pricing .period-btn[data-period="' + period + '"]');
    if (btn && typeof pricingSetPeriod === 'function') { pricingSetPeriod(period, btn); return true; }
    return false;
  }
  function goToOffer() {
    closeCard();
    var p = promoPeriods();
    var target = p.length ? p[p.length - 1] : '1Y';
    var pricing = document.getElementById('pricing');
    if (pricing && switchPeriod(target)) {
      pricing.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    } else {
      location.href = 'index.html#pricing';
    }
  }

  // ---------- полоса, значок, карточка ----------
  function build() {
    if (ui) return;
    var ph = phase();
    if (!ph) return;
    var soon = ph === 'soon';
    ui = { phase: ph };
    var what = offerWhat();
    var gift = monthsWord(info.months);

    if (sget(STRIP_KEY + ph) !== '1') {
      ui.strip = el('div', 'rsvp-strip');
      ui.strip.setAttribute('role', 'region');
      ui.strip.setAttribute('aria-label', promoName());
      ui.strip.innerHTML =
        '<div class="rsvp-strip-in"><b class="rsvp-mono">' + esc(badgeText()) + '</b>' +
        (soon
          ? '<span>Скоро акция: ' + esc(fromToText()) + ' ' + esc(what.toLowerCase()) + ' — +' + esc(gift) + ' в подарок</span>' +
            '<button type="button" class="rsvp-strip-go">Подробнее →</button>'
          : '<span>' + esc(what) + ' — +' + esc(gift) + ' в подарок</span>' +
            '<span class="rsvp-strip-dates">· ' + esc(datesText()) + '</span>' +
            '<button type="button" class="rsvp-strip-go">Выбрать →</button>') +
        '</div><button type="button" class="rsvp-strip-x" aria-label="Закрыть полосу акции">×</button>';
      document.body.insertBefore(ui.strip, document.body.firstChild);
      ui.strip.querySelector('.rsvp-strip-go').addEventListener('click', function () {
        if (soon && ui && ui.card) openCard(true); else goToOffer();
      });
      ui.strip.querySelector('.rsvp-strip-x').addEventListener('click', function () {
        sset(STRIP_KEY + ph, '1'); ui.strip.remove(); ui.strip = null;
      });
    }

    if (sget(HIDE_KEY) === '1') return;

    var yearly = promoPeriods().length === 1 && promoPeriods()[0] === '1Y';
    ui.shade = el('div', 'rsvp-shade');
    ui.badge = el('button', 'rsvp-badge',
      GIFT_SVG + '<span class="rsvp-badge-num">' + esc(badgeText()) + '</span><span class="rsvp-badge-lbl">' +
      (soon ? 'скоро' : 'акция') + '</span>');
    ui.badge.type = 'button';
    ui.badge.setAttribute('aria-expanded', 'false');
    ui.badge.setAttribute('aria-controls', 'rsvp-card');
    ui.badge.setAttribute('aria-label', promoName() + (soon ? ', ' + fromToText() : '') + ': ' + what.toLowerCase() +
      ' — плюс ' + gift + ' в подарок');
    ui.card = el('div', 'rsvp-card');
    ui.card.id = 'rsvp-card';
    ui.card.setAttribute('role', 'dialog');
    ui.card.setAttribute('aria-label', promoName());
    ui.card.innerHTML =
      '<div class="rsvp-card-top"><span class="rsvp-grip"></span>' +
        '<span class="rsvp-card-big">' + esc(badgeText()) + '</span>' +
        '<span class="rsvp-card-dates">' + esc(datesText()) + ' · по московскому времени</span>' +
        '<button type="button" class="rsvp-card-close" aria-label="Свернуть">×</button></div>' +
      '<div class="rsvp-card-body">' +
        '<div class="rsvp-card-head">' + (soon ? 'Скоро: ' + esc(what.toLowerCase()) : esc(what)) +
          ' — <em>+' + esc(gift) + ' в подарок</em></div>' +
        '<ul class="rsvp-card-list">' +
          (yearly ? '<li>' + (12 + info.months) + ' месяцев по цене 12</li>' : '') +
          '<li>при покупке, продлении и переходе ' + (yearly ? 'на годовой тариф' : 'на тариф со сроком из акции') +
            (soon ? ' ' + esc(fromToText()) : '') + '</li>' +
          (soon
            ? '<li>до ' + esc(dayMonth(info.startMs)) + ' подарок не добавляется</li>'
            : '<li>подарок добавляется к сроку сам после оплаты</li>') +
        '</ul>' +
        '<div class="rsvp-count">До ' + (soon ? 'начала' : 'конца') + ' акции осталось <b class="rsvp-left"></b></div>' +
        '<button type="button" class="rsvp-btn rsvp-go">' +
          (soon ? 'Посмотреть тарифы' : (yearly ? 'Выбрать годовой тариф' : 'Выбрать тариф')) + '</button>' +
        '<button type="button" class="rsvp-hide">Скрыть значок</button>' +
      '</div>';
    ui.toast = el('button', 'rsvp-toast',
      '<b>' + esc(badgeText()) + '</b> ' + (soon ? 'Скоро: ' + esc(what.toLowerCase()) : esc(what)) +
      ' — +' + esc(gift) + ' в подарок' + (soon ? ', ' + esc(fromToText()) : ''));
    ui.toast.type = 'button';
    document.body.appendChild(ui.shade);
    document.body.appendChild(ui.card);
    document.body.appendChild(ui.toast);
    document.body.appendChild(ui.badge);
    ui.toast.addEventListener('click', function () { openCard(true); });

    ui.badge.addEventListener('click', function () {
      if (ui.card.classList.contains('rsvp-open')) closeCard(); else openCard(true);
    });
    ui.card.querySelector('.rsvp-card-close').addEventListener('click', closeCard);
    ui.card.querySelector('.rsvp-go').addEventListener('click', goToOffer);
    ui.card.querySelector('.rsvp-hide').addEventListener('click', function () {
      sset(HIDE_KEY, '1'); closeCard();
      ['badge', 'card', 'shade', 'toast'].forEach(function (k) { if (ui[k]) { ui[k].remove(); ui[k] = null; } });
    });
    ui.shade.addEventListener('click', closeCard);
    // Посетитель взялся за карточку — сама она уже не сворачивается.
    ['pointerenter', 'focusin', 'touchstart'].forEach(function (ev) {
      ui.card.addEventListener(ev, function () { if (autoTimer) { clearTimeout(autoTimer); autoTimer = null; } }, { passive: true });
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && ui && ui.card && ui.card.classList.contains('rsvp-open')) closeCard();
    });

    // Первый заход за визит: на компьютере карточка раскрывается сама на несколько
    // секунд и не затемняет страницу; на телефоне вместо неё — короткая подсказка у
    // значка (карточка заняла бы полэкрана). Читать сайт ни то ни другое не мешает.
    if (sget(SEEN_KEY + ph) !== '1') {
      sset(SEEN_KEY + ph, '1');
      setTimeout(function () {
        if (!ui || !ui.card || document.querySelector('.email-modal-bg.active')) return;
        if (isPhone()) ui.toast.classList.add('rsvp-open'); else openCard(false);
        autoTimer = setTimeout(function () { autoTimer = null; closeCard(); }, 7000);
      }, 1200);
    }
  }

  function openCard(manual) {
    if (!ui || !ui.card) return;
    if (ui.toast) ui.toast.classList.remove('rsvp-open');
    ui.card.querySelector('.rsvp-left').textContent = leftText();
    ui.card.classList.add('rsvp-open');
    ui.badge.setAttribute('aria-expanded', 'true');
    if (manual && isPhone()) ui.shade.classList.add('rsvp-on');
  }
  function closeCard() {
    if (autoTimer) { clearTimeout(autoTimer); autoTimer = null; }
    if (!ui || !ui.card) return;
    if (ui.toast) ui.toast.classList.remove('rsvp-open');
    ui.card.classList.remove('rsvp-open');
    ui.shade.classList.remove('rsvp-on');
    ui.badge.setAttribute('aria-expanded', 'false');
  }

  function removeUi() {
    if (autoTimer) { clearTimeout(autoTimer); autoTimer = null; }
    if (ui) ['strip', 'badge', 'card', 'shade', 'toast'].forEach(function (k) { if (ui[k]) ui[k].remove(); });
    ui = null;
  }
  function refreshAll() { refreshPricing(); refreshBuy(); refreshUpgrade(); }

  // ---------- раздел «Цены» ----------
  function refreshPricing() {
    var sw = document.querySelector('#pricing .period-switcher');
    if (!sw) return;
    var on = active(), soon = phase() === 'soon';
    sw.querySelectorAll('.period-btn').forEach(function (b) {
      var chip = b.querySelector('.rsvp-chip');
      var want = on && anyHasPeriod(b.getAttribute('data-period'));
      if (want && !chip) b.appendChild(el('span', 'rsvp-chip', '+' + info.months + ' мес.'));
      if (!want && chip) chip.remove();
    });

    var period = (typeof pricingPeriod !== 'undefined') ? pricingPeriod : '';
    var hint = document.getElementById('rsvp-period-hint');
    var offerPeriod = promoPeriods().slice(-1)[0];
    var showHint = (on && offerPeriod && period && period !== 'LT' && !anyHasPeriod(period)) || (soon && !!offerPeriod);
    if (showHint && !hint) {
      hint = el('div', 'rsvp-hint');
      hint.id = 'rsvp-period-hint';
      var anchor = document.getElementById('period-hint') || sw;
      anchor.parentNode.insertBefore(hint, anchor.nextSibling);
    }
    if (hint) {
      hint.hidden = !showHint;
      if (showHint && soon) {
        hint.innerHTML = '<span class="rsvp-hint-mark rsvp-mono">' + esc(badgeText()) + '</span>' +
          '<span>Скоро ' + esc(promoName().toLowerCase()) + ': ' + esc(fromToText()) + ' ' + esc(offerWhat().toLowerCase()) +
          ' — <b>+' + esc(monthsWord(info.months)) + ' в подарок</b>' +
          (offerPeriod === '1Y' ? ', ' + (12 + info.months) + ' месяцев по цене 12' : '') + '.</span>' +
          '<span>До начала — ' + esc(leftText()) + '.</span>';
      } else if (showHint) {
        hint.innerHTML = '<span class="rsvp-hint-mark rsvp-mono">' + esc(badgeText()) + '</span>' +
          '<span>' + esc(promoName()) + ': ' + PERIOD_ON[offerPeriod] + ' — <b>+' + esc(monthsWord(info.months)) + ' в подарок</b>' +
          (offerPeriod === '1Y' ? ', ' + (12 + info.months) + ' месяцев по цене 12' : '') + '.</span>' +
          '<button type="button" class="rsvp-link">Показать ' + (offerPeriod === '1Y' ? 'годовой' : PERIOD_NAMES[offerPeriod]) + ' →</button>';
        hint.querySelector('.rsvp-link').addEventListener('click', function () { switchPeriod(offerPeriod); });
      }
    }

    if (typeof PRICING_TIERS === 'undefined' || typeof PRICING_DATA === 'undefined') return;
    PRICING_TIERS.forEach(function (t) {
      var total = document.getElementById('pc-total-' + t);
      if (!total) return;
      var gift = document.getElementById('rsvp-gift-' + t);
      var want = on && hasPromo(t, period) && PRICING_DATA[period] && PRICING_DATA[period][t] != null;
      if (want && !gift) {
        gift = el('div', 'rsvp-gift');
        gift.id = 'rsvp-gift-' + t;
        total.parentNode.insertBefore(gift, total.nextSibling);
      }
      if (gift) {
        gift.hidden = !want;
        if (want) {
          var m = PERIOD_MONTHS[period] + info.months;
          gift.innerHTML = GIFT_SVG + '<span><b>+' + esc(monthsWord(info.months)) + ' в подарок</b><br>' + m + ' месяцев · ' +
            fmt(PRICING_DATA[period][t] / m) + '&nbsp;₽/мес</span>';
        }
      }
    });
  }

  // ---------- окно покупки ----------
  function refreshBuy() {
    var modal = document.querySelector('#email-modal-bg .email-modal-box');
    if (!modal) return;
    var box = document.getElementById('rsvp-buy');
    var tier = (typeof pricingTier !== 'undefined') ? pricingTier : '';
    var period = (typeof pricingPeriod !== 'undefined') ? pricingPeriod : '';
    var data = (typeof PRICING_DATA !== 'undefined') ? PRICING_DATA : null;
    var ph = phase();
    var show = !!ph && tier && data && period && period !== 'LT' && data[period] && data[period][tier] != null;
    var target = show ? (hasPromo(tier, period) ? period : bestPeriod(tier)) : '';
    if (!target) show = false;
    if (show && !box) {
      box = el('div', 'rsvp-box');
      box.id = 'rsvp-buy';
      var anchor = modal.querySelector('.em-terms-row');
      modal.insertBefore(box, anchor);
    }
    if (!box) return;
    box.hidden = !show;
    if (!show) return;

    var promoUsed = (typeof validPromoCode !== 'undefined') && !!validPromoCode;
    var gift = monthsWord(info.months);
    if (ph === 'soon') {
      // До начала подарок не выдаётся — не обещаем, а честно говорим, когда он будет.
      box.className = 'rsvp-box rsvp-up';
      box.innerHTML = '<b>' + esc(promoName()) + ' начнётся ' + esc(dayMonth(info.startMs)) + '.</b>' +
        '<span>' + (target === '1Y' ? 'Годовой тариф' : 'Тариф ' + PERIOD_ON[target]) + ', оплаченный ' + esc(fromToText()) +
        ', получит +' + esc(gift) + ' в подарок. При оплате сейчас подарок не добавляется.</span>';
      return;
    }
    if (target === period) {
      if (promoUsed && !info.withPromocode) {
        box.className = 'rsvp-box rsvp-warn';
        box.innerHTML = '<b>С промокодом подарок по акции не добавляется.</b>' +
          '<span>Акция и промокод не суммируются: без промокода к сроку добавится ещё ' + esc(gift) + '.</span>';
      } else {
        box.className = 'rsvp-box rsvp-ok';
        box.innerHTML = '<b>Подарок по акции' + (info.badge ? ' ' + esc(info.badge) : '') + ': +' + esc(gift) + '.</b>' +
          '<span>Срок кода — ' + monthsWord(PERIOD_MONTHS[period] + info.months) + ', подарок добавится сам после оплаты.</span>';
      }
      return;
    }
    var nowPrice = data[period][tier], nowMonths = PERIOD_MONTHS[period];
    var offerPrice = data[target][tier], offerMonths = PERIOD_MONTHS[target] + info.months;
    box.className = 'rsvp-box rsvp-up';
    box.innerHTML =
      '<b>' + esc(promoName()) + ': ' + PERIOD_ON[target] + ' — +' + esc(gift) + ' в подарок.</b>' +
      '<span class="rsvp-cmp">Сейчас выбрано: ' + PERIOD_NAMES[period] + ' за <b>' + fmt(nowPrice) + ' ₽</b> — ' +
        fmt(nowPrice / nowMonths) + ' ₽ в месяц. ' + (target === '1Y' ? 'Год' : PERIOD_NAMES[target]) + ' с подарком: ' +
        offerMonths + ' месяцев за <b>' + fmt(offerPrice) + ' ₽</b> — ' + fmt(offerPrice / offerMonths) + ' ₽ в месяц.</span>' +
      (promoUsed && !info.withPromocode ? '<span>С промокодом подарок по акции не добавляется.</span>' : '') +
      '<button type="button" class="rsvp-btn">Взять ' + PERIOD_ON[target] + ' — ' + offerMonths + ' месяцев за ' + fmt(offerPrice) + ' ₽</button>';
    box.querySelector('.rsvp-btn').addEventListener('click', function () {
      switchPeriod(target);
      refreshBuy();
      // Скидка промокода может зависеть от срока — пересчитать.
      var promo = document.getElementById('pricing-promo-input');
      if (promo && promo.value.trim() && typeof promoChanged === 'function') promoChanged();
    });
  }

  // ---------- окно смены тарифа ----------
  var upgradeState = { tierCode: '', anchor: null };
  function refreshUpgrade(newTierCode, anchor) {
    if (newTierCode !== undefined) upgradeState = { tierCode: String(newTierCode || '').toUpperCase(), anchor: anchor || null };
    var box = document.getElementById('rsvp-upg');
    var ph = phase();
    var show = !!ph && upgradeState.tierCode && info.tiers.indexOf(upgradeState.tierCode) !== -1 && upgradeState.anchor;
    if (show && !box) {
      box = el('div', 'rsvp-box rsvp-ok');
      box.id = 'rsvp-upg';
      var a = upgradeState.anchor;
      a.parentNode.insertBefore(box, a.nextSibling);
    }
    if (!box) return;
    box.hidden = !show;
    if (show) {
      var period = upgradeState.tierCode.split('-')[1];
      if (ph === 'soon') {
        box.className = 'rsvp-box rsvp-up';
        box.innerHTML = '<b>' + esc(promoName()) + ' начнётся ' + esc(dayMonth(info.startMs)) + '.</b>' +
          '<span>Переход ' + (PERIOD_ON[period] || '') + ', оплаченный ' + esc(fromToText()) + ', получит +' +
          esc(monthsWord(info.months)) + ' в подарок. При оплате сейчас подарок не добавляется.</span>';
      } else {
        box.className = 'rsvp-box rsvp-ok';
        box.innerHTML = '<b>' + esc(promoName()) + ': переход ' + (PERIOD_ON[period] || '') + ' — +' + esc(monthsWord(info.months)) + ' в подарок.</b>' +
          '<span>Подарок добавится к новому сроку после оплаты — один раз на лицензию за время акции.</span>';
      }
    }
  }

  window.RsvPromo = { refreshPricing: refreshPricing, refreshBuy: refreshBuy, refreshUpgrade: refreshUpgrade };

  // ---------- запуск ----------
  function start(data, fetchedAt) {
    if (!data || !data.success || !data.tiers || !data.tiers.length || !(data.months > 0) ||
        typeof data.startMs !== 'number' || typeof data.endMs !== 'number') return;
    info = data;
    skew = (typeof data.now === 'number') ? data.now - fetchedAt : 0;
    if (now() >= info.endMs) return;
    build();
    refreshAll();
    // Раз в 30 секунд: счётчик, а на границе — смена «скоро» → «идёт» → ничего.
    ticker = setInterval(function () {
      var ph = phase();
      if ((ui ? ui.phase : '') !== ph) { removeUi(); build(); refreshAll(); }
      else if (ph === 'soon') refreshPricing();
      if (ui && ui.card) ui.card.querySelector('.rsvp-left').textContent = leftText();
      if (now() >= info.endMs) { clearInterval(ticker); ticker = null; }
    }, 30000);
  }

  // Просмотр на своём компьютере без живого скрипта: открыть страницу как файл
  // или с localhost и добавить ?promo-preview — акция показывается на примере:
  // настройки акции 11.11 (9–13 ноября 2026, +3 месяца к годовому), а часы стоят
  // на 9 ноября 12:00 МСК — как будто акция уже идёт. На опубликованном сайте
  // этого режима нет: там всё берётся у скрипта.
  var local = location.protocol === 'file:' || /^(localhost|127\.0\.0\.1)$/.test(location.hostname);
  // ?promo-preview=soon — анонс: часы на 7 ноября 12:00 МСК, до начала 1 день 12 часов.
  var pv = /[?&]promo-preview(=([a-z]+))?\b/.exec(location.search);
  if (local && pv) {
    start({ success: true, active: pv[2] !== 'soon',
      now: pv[2] === 'soon' ? Date.UTC(2026, 10, 7, 9) : Date.UTC(2026, 10, 9, 9),
      announceMs: Date.UTC(2026, 10, 1, 21),
      startMs: Date.UTC(2026, 10, 8, 21), endMs: Date.UTC(2026, 10, 13, 21),
      months: 3, tiers: ['ANL-1Y', 'DEV-1Y', 'ARC-1Y', 'PRO-1Y'], withPromocode: true, badge: '11.11' }, Date.now());
    return;
  }

  try {
    var cached = JSON.parse(sget(CACHE_KEY) || 'null');
    if (cached && Date.now() - cached.at < CACHE_TTL) { start(cached.data, cached.at); return; }
  } catch (e) { /* нет памяти визита — спросим скрипт */ }

  fetch(GAS + '?action=promo-info')
    .then(function (r) { return r.json(); })
    .then(function (d) {
      var at = Date.now();
      if (d && d.success) sset(CACHE_KEY, JSON.stringify({ at: at, data: d }));
      start(d, at);
    })
    .catch(function () { /* скрипт не ответил — акцию не показываем */ });
})();
