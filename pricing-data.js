/* Прайс MCP:RSV Server — один на все страницы сайта (главная, счёт для организации).
   Регулярные цены (тарифы Аналитик / Разработчик / Архитектор / Архитектор Про).
   Период-скидки: 3 мес −15%, 6 мес −20%, 1 год −25%.
   «Навсегда» (LT) продаётся только для «Архитектор» и «Архитектор Про»; промокоды на LT не действуют.
   Ключи AMOUNT_MAP на сервере (Code.gs) держать синхронно: PRO-1M/3M/6M/1Y, ARC-LT, PRO-LT. */
const PRICING_DATA = {
  '1M': { ANL:1500,  DEV:3500,  ARC:4900,  PRO:7900,  disc:null },
  '3M': { ANL:3800,  DEV:8900,  ARC:12500, PRO:20100, disc:'−15%', pm:{ANL:1267, DEV:2967, ARC:4167, PRO:6700}, label:'3 месяца' },
  '6M': { ANL:7200,  DEV:16800, ARC:23500, PRO:37900, disc:'−20%', pm:{ANL:1200, DEV:2800, ARC:3917, PRO:6317}, label:'6 месяцев' },
  '1Y': { ANL:13500, DEV:31500, ARC:44000, PRO:71000, disc:'−25%', pm:{ANL:1125, DEV:2625, ARC:3667, PRO:5917}, label:'1 год' },
  'LT': { ARC:120000, PRO:180000, lifetime:true, label:'навсегда' }
};
const PRICING_TIERS = ['ANL','DEV','ARC','PRO'];
/* Адрес скрипта лицензий MCP:RSV Server — оплата, промокоды, продление, акция, счёт. */
const PRICING_GAS = 'https://script.google.com/macros/s/AKfycbzXuSR6nMP7wDIW9tQthJyGBbF7B9BI4hId4z-Npo8PRkMcH_B798HBXOW0cNaWdjInWw/exec';
