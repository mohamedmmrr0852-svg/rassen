// ================================================================
//  RASEEN — Railway (Node.js) Server
//  Firebase Realtime Database
//  Environment Variables:
//    FIREBASE_DATABASE_URL  e.g. https://YOUR-DB.firebaseio.com
//    FIREBASE_API_KEY       Firebase API key
//    BOT_TOKEN              Telegram Bot Token
//    ADMIN_IDS              comma-separated admin Telegram IDs
//    PORT                   (optional, default 3000)
// ===============================================================

import express from 'express';
import { createHmac } from 'crypto';
const app = express();
app.use(express.text({ limit: '11kb', type: '*/*' }));

// env shim — reads from process.env
const env = new Proxy({}, { get: (_, k) => process.env[k] });

// ctx shim — waitUntil runs in background without blocking response
const ctx = { waitUntil: (p) => { Promise.resolve(p).catch(e => console.error('bg task error:', e?.message)); } };


const G = {
  MIN_WITHDRAW_TON: 0.0001,
  WITHDRAW_FEE_PCT: 10, // 10% withdrawal fee
  MIN_DEPOSIT_TON: 1,
  REF_BONUS_PCT: 10,
  // Referral TON tasks (active referrals only - who have withdrawn)
  REF_TON_TASKS: {
    rt10  : { n:10,   ton:0.1  },
    rt50  : { n:50,   ton:0.5  },
    rt100 : { n:100,  ton:1    },
    rt200 : { n:200,  ton:2    },
    rt500 : { n:500,  ton:5    },
    rt1000: { n:1000, ton:10   },
  },
  // Bike purchase tasks
  BIKE_TASKS: {
    bt5  : { n:5,  ton:2  },
    bt10 : { n:10, ton:20 },
  },
  // Race tasks (number of races played)
  RACE_TASKS: {
    rc10 : { n:10,  ton:0.5 },
    rc20 : { n:20,  ton:1   },
    rc50 : { n:50,  ton:3   },
  },
  // Mining tasks (number of times sent to mining)
  MINE_TASKS: {
    mt20 : { n:20, ton:1 },
    mt50 : { n:50, ton:3 },
  },
  // Upgrade increments per stat — must match frontend UPGRADE_INC
  UPGRADE_INCREMENTS: {
    speed   : 5,
    nitro   : 5,
    accel   : 5,
    maneuver: 3,
  },
};

// Bike base stats
const BIKE_BASE_STATS = {
  0 :{ speed:10,  nitro:5,   accel:3,  maneuver:2,  price:0   },
  1 :{ speed:40,  nitro:20,  accel:15, maneuver:10, price:1   },
  2 :{ speed:60,  nitro:35,  accel:25, maneuver:16, price:5   },
  3 :{ speed:90,  nitro:55,  accel:38, maneuver:24, price:10  },
  4 :{ speed:135, nitro:85,  accel:57, maneuver:36, price:20  },
  5 :{ speed:200, nitro:130, accel:85, maneuver:50, price:50  },
  6 :{ speed:300, nitro:200, accel:125,maneuver:70, price:100 },
  7 :{ speed:450, nitro:300, accel:180,maneuver:95, price:200 },
  8 :{ speed:700, nitro:450, accel:260,maneuver:130,price:250 },
  9 :{ speed:1100,nitro:700, accel:380,maneuver:180,price:400 },
  10:{ speed:1800,nitro:1100,accel:550,maneuver:250,price:500 },
};

const BIKE_DAILY_TON = {
  0:0.0001,
  1:0.022, 2:0.111, 3:0.222, 4:0.444, 5:1.11,
  6:2.22, 7:4.44, 8:5.55, 9:8.88, 10:11.11,
};
const BIKE_MINING_MS = 24*60*60*1000;

// Real-world bike model names (single source of truth)
const BIKE_NAMES = {
  0:  'Specialized Allez',
  1:  'Honda CB350',
  2:  'Honda CBR650R',
  3:  'Suzuki GSX-S750',
  4:  'Suzuki GSX-R1000',
  5:  'Kawasaki Z900',
  6:  'KTM RC 8C',
  7:  'Kawasaki Ninja H2',
  8:  'Bike Level 8',
  9:  'Bike Level 9',
  10: 'Bike Level 10',
};

// Default partner tasks
const DEFAULT_PARTNER_TASKS = [
  { id:'partner_payouts', name:'Join Payouts Channel', type:'channel', link:'https://t.me/RaseenRacing_chat', imageUrl:'https://res.cloudinary.com/dktppfipy/image/upload/v1778747937/payments_c5ifxk.jpg', bambooReward:100, targetUsers:null, status:'active', isDefault:true },
  { id:'partner_news',    name:'Join News Channel',    type:'channel', link:'https://t.me/RaseenRacing',        imageUrl:'https://res.cloudinary.com/dktppfipy/image/upload/v1778747938/news_ek96ui.jpg',     bambooReward:100, targetUsers:null, status:'active', isDefault:true },
];

async function seedPartnerTasks(env){
  try{
    const tpr=await dbGet(env,'tasks/partner');
    const existing=tpr.data||{};
    for(const task of DEFAULT_PARTNER_TASKS){
      const now=Date.now();
      if(!existing[task.id]){
        await dbSet(env,`tasks/partner/${task.id}`,{...task,completions:0,completedBy:[],createdAt:now,updatedAt:now});
      } else {
        // Always force-update link and imageUrl for default tasks (fix stale data)
        await dbUpdate(env,`tasks/partner/${task.id}`,{link:task.link,imageUrl:task.imageUrl,name:task.name,updatedAt:now});
      }
    }
  }catch(e){console.error('seedPartnerTasks:',e.message);}
}

// ── Multilingual Notification Messages ──────────────────────────
const MSG={
  ref_joined:{
    ar:(name)=>`🎉 <b>${name}</b> انضم باستخدام رابط إحالتك!\n\n🏍️ ستكسب عمولة 10% من مشترياته.`,
    en:(name)=>`🎉 <b>${name}</b> joined using your referral link!\n\n🏍️ You will earn 10% commission on their purchases.`,
    ru:(name)=>`🎉 <b>${name}</b> присоединился по вашей реферальной ссылке!\n\n🏍️ Вы будете получать 10% комиссию с их покупок.`,
    es:(name)=>`🎉 <b>${name}</b> se unió usando tu enlace de referido!\n\n🏍️ Ganarás 10% de comisión en sus compras.`,
    fr:(name)=>`🎉 <b>${name}</b> a rejoint via votre lien de parrainage!\n\n🏍️ Vous gagnerez 10% de commission sur ses achats.`,
  },
  bike_bought:{
    ar:(bkName,lv,speed,nitro,accel,maneuver,daily,monthly)=>`🏍️ <b>تم شراء الدراجة!</b>\n\n🎉 <b>${bkName} (المستوى ${lv})</b>\n\n📊 السرعة:${speed} النيترو:${nitro} التسارع:${accel} المناورة:${maneuver}\n\n💰 يومياً: ${daily} TON | شهرياً: ~${monthly} TON\n\n🔋 أرسلها للتعدين لتبدأ الكسب!`,
    en:(bkName,lv,speed,nitro,accel,maneuver,daily,monthly)=>`🏍️ <b>Bike Purchased!</b>\n\n🎉 <b>${bkName} (Lv${lv})</b>\n\n📊 Speed:${speed} Nitro:${nitro} Accel:${accel} Handling:${maneuver}\n\n💰 Daily: ${daily} TON | Monthly: ~${monthly} TON\n\n🔋 Send to mining to start earning!`,
    ru:(bkName,lv,speed,nitro,accel,maneuver,daily,monthly)=>`🏍️ <b>Мотоцикл куплен!</b>\n\n🎉 <b>${bkName} (Ур.${lv})</b>\n\n📊 Скорость:${speed} Нитро:${nitro} Ускор:${accel} Управл:${maneuver}\n\n💰 В день: ${daily} TON | В месяц: ~${monthly} TON\n\n🔋 Отправьте в майнинг для заработка!`,
    es:(bkName,lv,speed,nitro,accel,maneuver,daily,monthly)=>`🏍️ <b>¡Moto Comprada!</b>\n\n🎉 <b>${bkName} (Nv${lv})</b>\n\n📊 Vel:${speed} Nitro:${nitro} Acel:${accel} Manejo:${maneuver}\n\n💰 Diario: ${daily} TON | Mensual: ~${monthly} TON\n\n🔋 ¡Envíala a minería para empezar a ganar!`,
    fr:(bkName,lv,speed,nitro,accel,maneuver,daily,monthly)=>`🏍️ <b>Moto Achetée!</b>\n\n🎉 <b>${bkName} (Nv${lv})</b>\n\n📊 Vitesse:${speed} Nitro:${nitro} Accél:${accel} Maniab:${maneuver}\n\n💰 Quotidien: ${daily} TON | Mensuel: ~${monthly} TON\n\n🔋 Envoyez en minage pour commencer à gagner!`,
  },
  ref_commission:{
    ar:(firstName,lv,comm,newBal)=>`💰 <b>عمولة إحالة!</b>\n\n🏍️ <b>${firstName}</b> اشترى دراجة المستوى ${lv}\n💤 +${comm} TON (10%) أضيف لرصيدك!\n💰 الرصيد الجديد: ${newBal} TON`,
    en:(firstName,lv,comm,newBal)=>`💰 <b>Referral Commission!</b>\n\n🏍️ <b>${firstName}</b> bought a Level ${lv} bike\n💤 +${comm} TON (10%) added to your balance!\n💰 New balance: ${newBal} TON`,
    ru:(firstName,lv,comm,newBal)=>`💰 <b>Реферальная комиссия!</b>\n\n🏍️ <b>${firstName}</b> купил мотоцикл уровня ${lv}\n💤 +${comm} TON (10%) добавлено к вашему балансу!\n💰 Новый баланс: ${newBal} TON`,
    es:(firstName,lv,comm,newBal)=>`💰 <b>¡Comisión de Referido!</b>\n\n🏍️ <b>${firstName}</b> compró una moto de nivel ${lv}\n💤 +${comm} TON (10%) añadido a tu saldo!\n💰 Nuevo saldo: ${newBal} TON`,
    fr:(firstName,lv,comm,newBal)=>`💰 <b>Commission de Parrainage!</b>\n\n🏍️ <b>${firstName}</b> a acheté une moto niveau ${lv}\n💤 +${comm} TON (10%) ajouté à votre solde!\n💰 Nouveau solde: ${newBal} TON`,
  },
  mining_done:{
    ar:(ton)=>`🏍️ اكتمل تعدين الدراجة!\n\n💎 +${ton} TON تمت إضافته لرصيدك.`,
    en:(ton)=>`🏍️ Bike mining completed!\n\n💎 +${ton} TON has been added to your balance.`,
    ru:(ton)=>`🏍️ Майнинг мотоцикла завершён!\n\n💎 +${ton} TON добавлено к вашему балансу.`,
    es:(ton)=>`🏍️ ¡Minería de moto completada!\n\n💎 +${ton} TON añadido a tu saldo.`,
    fr:(ton)=>`🏍️ Minage de moto terminé!\n\n💎 +${ton} TON ajouté à votre solde.`,
  },
  task_done:{
    ar:(label,ton)=>`🎯 <b>مهمة الإحالة مكتملة!</b>\n\n✅ ${label}\n💎 +${ton} TON أضيف!`,
    en:(label,ton)=>`🎯 <b>Referral Task Done!</b>\n\n✅ ${label}\n💎 +${ton} TON added!`,
    ru:(label,ton)=>`🎯 <b>Реферальное задание выполнено!</b>\n\n✅ ${label}\n💎 +${ton} TON добавлено!`,
    es:(label,ton)=>`🎯 <b>¡Tarea de Referido Completada!</b>\n\n✅ ${label}\n💎 +${ton} TON añadido!`,
    fr:(label,ton)=>`🎯 <b>Tâche de Parrainage Terminée!</b>\n\n✅ ${label}\n💎 +${ton} TON ajouté!`,
  },
  mission_done:{
    ar:(label,ton)=>`🎯 <b>المهمة مكتملة!</b>\n\n✅ ${label}\n💎 +${ton} TON أضيف!`,
    en:(label,ton)=>`🎯 <b>Mission Completed!</b>\n\n✅ ${label}\n💎 +${ton} TON added!`,
    ru:(label,ton)=>`🎯 <b>Миссия выполнена!</b>\n\n✅ ${label}\n💎 +${ton} TON добавлено!`,
    es:(label,ton)=>`🎯 <b>¡Misión Completada!</b>\n\n✅ ${label}\n💎 +${ton} TON añadido!`,
    fr:(label,ton)=>`🎯 <b>Mission Accomplie!</b>\n\n✅ ${label}\n💎 +${ton} TON ajouté!`,
  },
  race_won:{
    ar:(loserName,prize)=>`🏆 <b>فزت بالسباق!</b>\n\n🏍️ هزمت <b>${loserName}</b>\n💤 +${prize} TON أضيف لرصيدك!`,
    en:(loserName,prize)=>`🏆 <b>Race Won!</b>\n\n🏍️ You beat <b>${loserName}</b>\n💤 +${prize} TON added to your balance!`,
    ru:(loserName,prize)=>`🏆 <b>Гонка выиграна!</b>\n\n🏍️ Вы победили <b>${loserName}</b>\n💤 +${prize} TON добавлено к вашему балансу!`,
    es:(loserName,prize)=>`🏆 <b>¡Carrera Ganada!</b>\n\n🏍️ Venciste a <b>${loserName}</b>\n💤 +${prize} TON añadido a tu saldo!`,
    fr:(loserName,prize)=>`🏆 <b>Course Gagnée!</b>\n\n🏍️ Vous avez battu <b>${loserName}</b>\n💤 +${prize} TON ajouté à votre solde!`,
  },
  race_lost:{
    ar:(winnerName,cost,prize)=>`❌ <b>حظاً أوفر!</b>\n\n🏍️ <b>${winnerName}</b> فاز هذه المرة.\n💔 خسرت ${cost} TON رسوم الدخول.\n💪 تسابق مجدداً للفوز بـ ${prize} TON!`,
    en:(winnerName,cost,prize)=>`❌ <b>Hard Luck!</b>\n\n🏍️ <b>${winnerName}</b> beat you this time.\n💔 You lost ${cost} TON entry fee.\n💪 Race again to win ${prize} TON!`,
    ru:(winnerName,cost,prize)=>`❌ <b>Не повезло!</b>\n\n🏍️ <b>${winnerName}</b> победил на этот раз.\n💔 Вы потеряли ${cost} TON входной взнос.\n💪 Гоняйтесь снова, чтобы выиграть ${prize} TON!`,
    es:(winnerName,cost,prize)=>`❌ <b>¡Mala Suerte!</b>\n\n🏍️ <b>${winnerName}</b> te ganó esta vez.\n💔 Perdiste ${cost} TON de cuota de entrada.\n💪 ¡Vuelve a correr para ganar ${prize} TON!`,
    fr:(winnerName,cost,prize)=>`❌ <b>Pas de Chance!</b>\n\n🏍️ <b>${winnerName}</b> vous a battu cette fois.\n💔 Vous avez perdu ${cost} TON de frais d'entrée.\n💪 Recourez pour gagner ${prize} TON!`,
  },
  bike_upgraded:{
    ar:(lv,statName,oldVal,newVal,inc,price)=>`🛠️ <b>تم ترقية الدراجة!</b>\n\n🏍️ ${BIKE_NAMES[lv]||('Bike '+lv)}\n📊 ${statName}: ${oldVal} ← ${newVal} (+${inc})\n💎 التكلفة: ${price} TON`,
    en:(lv,statName,oldVal,newVal,inc,price)=>`🛠️ <b>Bike Upgraded!</b>\n\n🏍️ ${BIKE_NAMES[lv]||('Bike '+lv)}\n📊 ${statName}: ${oldVal} → ${newVal} (+${inc})\n💎 Cost: ${price} TON`,
    ru:(lv,statName,oldVal,newVal,inc,price)=>`🛠️ <b>Мотоцикл улучшен!</b>\n\n🏍️ ${BIKE_NAMES[lv]||('Bike '+lv)}\n📊 ${statName}: ${oldVal} → ${newVal} (+${inc})\n💎 Стоимость: ${price} TON`,
    es:(lv,statName,oldVal,newVal,inc,price)=>`🛠️ <b>¡Moto Mejorada!</b>\n\n🏍️ ${BIKE_NAMES[lv]||('Bike '+lv)}\n📊 ${statName}: ${oldVal} → ${newVal} (+${inc})\n💎 Costo: ${price} TON`,
    fr:(lv,statName,oldVal,newVal,inc,price)=>`🛠️ <b>Moto Améliorée!</b>\n\n🏍️ ${BIKE_NAMES[lv]||('Bike '+lv)}\n📊 ${statName}: ${oldVal} → ${newVal} (+${inc})\n💎 Coût: ${price} TON`,
  },
  wd_approved:{
    ar:(amt)=>`✅ تمت الموافقة على سحب ${amt} TON الخاص بك!`,
    en:(amt)=>`✅ Your withdrawal of ${amt} TON has been approved!`,
    ru:(amt)=>`✅ Ваш вывод ${amt} TON одобрен!`,
    es:(amt)=>`✅ ¡Tu retiro de ${amt} TON ha sido aprobado!`,
    fr:(amt)=>`✅ Votre retrait de ${amt} TON a été approuvé!`,
  },
  wd_rejected:{
    ar:(amt)=>`❌ تم رفض السحب. تمت استعادة ${amt} TON.`,
    en:(amt)=>`❌ Withdrawal rejected. ${amt} TON refunded.`,
    ru:(amt)=>`❌ Вывод отклонён. ${amt} TON возвращено.`,
    es:(amt)=>`❌ Retiro rechazado. ${amt} TON reembolsado.`,
    fr:(amt)=>`❌ Retrait rejeté. ${amt} TON remboursé.`,
  },
  post_approved:{
    ar:(reward)=>`✅ تمت الموافقة على منشورك! حصلت على مكافأة ${reward} TON.`,
    en:(reward)=>`✅ Your post has been approved! You received ${reward} TON reward.`,
    ru:(reward)=>`✅ Ваш пост одобрен! Вы получили ${reward} TON в награду.`,
    es:(reward)=>`✅ ¡Tu publicación ha sido aprobada! Recibiste ${reward} TON de recompensa.`,
    fr:(reward)=>`✅ Votre publication a été approuvée! Vous avez reçu ${reward} TON de récompense.`,
  },
  post_rejected:{
    ar:()=>`❌ تم رفض منشورك.`,
    en:()=>`❌ Your post was rejected.`,
    ru:()=>`❌ Ваш пост отклонён.`,
    es:()=>`❌ Tu publicación fue rechazada.`,
    fr:()=>`❌ Votre publication a été rejetée.`,
  },
  welcome_bike:{
    ar:(bkName,speed,nitro,accel,maneuver,daily,minWd)=>`🎁 <b>مكافأة التسجيل!</b>\n\n🏍️ حصلت على <b>${bkName}</b> مجاناً!\n\n📊 <b>المواصفات:</b>\n• السرعة: ${speed}\n• النيترو: ${nitro}\n• التسارع: ${accel}\n• المناورة: ${maneuver}\n\n💰 الربح اليومي: <b>${daily} TON</b>\n\n✅ يمكنك سحب أرباحك لأن الحد الأدنى للسحب هو <b>${minWd} TON</b> فقط!\n\n🔋 أرسلها للتعدين لتبدأ الكسب!`,
    en:()=>`🏍️🔥 <b>Welcome to RaseenRacing!</b> 🔥🏍️\n\nIf you've just joined us, welcome to the ultimate racing &amp; mining ecosystem on Telegram!\n\nHere, you don't just play… you earn TON through racing, mining, tasks, and referrals 💎\n\nHere's everything you need to start earning 👇\n\n━━━━━━━━━━━━━━\n🏁 <b>STEP 1 — Open the Bot</b>\n━━━━━━━━━━━━━━\nTap <b>"Play"</b>.\nInside the bot you can:\n• Buy bikes\n• Upgrade speed &amp; power\n• Join online PvP races\n• Send bikes to mining\n• Complete tasks\n• Invite friends &amp; earn commissions\n• Withdraw your TON rewards\n\n━━━━━━━━━━━━━━\n🏍️ <b>STEP 2 — Buy &amp; Upgrade Your Bike</b>\n━━━━━━━━━━━━━━\nGo to the <b>"Garage"</b> section.\n• Choose your bike\n• Upgrade speed, power, and performance\n• The stronger and faster your bike becomes, the higher your winning chances ⚡\n\n🎁 Every player also receives a <b>FREE starter bike</b> to begin mining and earning instantly.\n\n━━━━━━━━━━━━━━\n🏁 <b>STEP 3 — Online PvP Racing</b>\n━━━━━━━━━━━━━━\nCompete against REAL online players in fully integrated 3D races 🔥\n\nHow races work:\n• You join with <b>0.5 TON</b>\n• Your opponent joins with <b>0.5 TON</b>\n• The winner receives <b>0.9 TON</b> 💰\n\n⚙️ <b>Game Economy:</b>\nA 10% fee (0.1 TON) is taken from each race to support:\n• Bot liquidity\n• Stable economy\n• Reward systems\n• Future development\n\nThe better your bike is, the greater your chance of winning 🏆\n\n━━━━━━━━━━━━━━\n⛏️ <b>STEP 4 — Mining System</b>\n━━━━━━━━━━━━━━\nEvery bike generates passive daily mining income 💎\nSend your bike to mining and collect rewards automatically — even while offline.\n• Stronger bikes generate higher mining rewards\n• Even the FREE starter bike can mine daily rewards\n\n━━━━━━━━━━━━━━\n🎯 <b>STEP 5 — Complete Tasks</b>\n━━━━━━━━━━━━━━\nComplete daily and special tasks to receive:\n• Free TON rewards\n• Extra mining bonuses\n• Additional prizes &amp; rewards 🎁\n\n🔥 <b>Best part:</b>\nThere is NO minimum withdrawal limit for rewards earned from free tasks or mining.\n\n━━━━━━━━━━━━━━\n👥 <b>STEP 6 — Referral Program</b>\n━━━━━━━━━━━━━━\nInvite friends and build your passive TON income 🚀\n\nReferral rewards:\n• Earn <b>0.01 TON</b> per referral\n• Invite 100 users = <b>1 TON</b> 🔥\n• Plus <b>10% commission</b> from every deposit your referrals make\n\nThe more active your referrals are, the more you earn automatically.\n\n━━━━━━━━━━━━━━\n💸 <b>STEP 7 — Withdraw Earnings</b>\n━━━━━━━━━━━━━━\nWithdraw your TON rewards directly to your TON wallet anytime 💰\nYour earnings can come from:\n• Winning races\n• Daily mining\n• Free tasks\n• Referral commissions\n\n━━━━━━━━━━━━━━\n🔥 <b>FINAL REMINDER</b>\n━━━━━━━━━━━━━━\nRaseenRacing is not just a game…\nIt's a complete TON earning ecosystem.\n\n🏍️ Upgrade your bike\n🏁 Win PvP races\n⛏️ Collect mining rewards\n👥 Grow your referral network\n💎 Withdraw your TON anytime\n\nStart now and become a racing legend! 🚀`,
    ru:(bkName,speed,nitro,accel,maneuver,daily,minWd)=>`🎁 <b>Бонус за регистрацию!</b>\n\n🏍️ Вы получили <b>${bkName}</b> бесплатно!\n\n📊 <b>Характеристики:</b>\n• Скорость: ${speed}\n• Нитро: ${nitro}\n• Ускорение: ${accel}\n• Управление: ${maneuver}\n\n💰 Доход в день: <b>${daily} TON</b>\n\n✅ Вы можете вывести заработок — минимальный вывод всего <b>${minWd} TON</b>!\n\n🔋 Отправьте в майнинг, чтобы начать зарабатывать!`,
    es:(bkName,speed,nitro,accel,maneuver,daily,minWd)=>`🎁 <b>¡Bono de Registro!</b>\n\n🏍️ ¡Recibiste <b>${bkName}</b> GRATIS!\n\n📊 <b>Especificaciones:</b>\n• Velocidad: ${speed}\n• Nitro: ${nitro}\n• Aceleración: ${accel}\n• Manejo: ${maneuver}\n\n💰 Ganancia diaria: <b>${daily} TON</b>\n\n✅ Puedes retirar tus ganancias — el mínimo es solo <b>${minWd} TON</b>!\n\n🔋 ¡Envíala a minería para empezar a ganar!`,
    fr:(bkName,speed,nitro,accel,maneuver,daily,minWd)=>`🎁 <b>Bonus d'Inscription!</b>\n\n🏍️ Vous avez reçu <b>${bkName}</b> GRATUITEMENT!\n\n📊 <b>Caractéristiques:</b>\n• Vitesse: ${speed}\n• Nitro: ${nitro}\n• Accélération: ${accel}\n• Maniabilité: ${maneuver}\n\n💰 Gain quotidien: <b>${daily} TON</b>\n\n✅ Vous pouvez retirer vos gains — le minimum est de seulement <b>${minWd} TON</b>!\n\n🔋 Envoyez en minage pour commencer à gagner!`,
  },
};
// Get user language (saved in DB) or fallback to 'en'
async function getUserLang(env,uid){
  try{const r=await dbGet(env,`users/${uid}/language`);return(r.data&&['ar','en','ru','es','fr'].includes(r.data))?r.data:'en';}catch(_){return'en';}
}
// Get localised message or fallback to English
function m(key,lang,...args){
  const variants=MSG[key];if(!variants)return'';
  const fn=variants[lang]||variants['en'];
  return fn?fn(...args):'';
}

const PLAY_BUTTON={reply_markup:{inline_keyboard:[[{text:'🏍️ Play',url:'https://t.me/RaseenRacing_bot/app?startapp='}]]}};

// All bot notifications include a Play button
async function sendTgNotification(env,userId,message){
  try{
    if(!process.env.BOT_TOKEN){console.warn('sendTgNotification: BOT_TOKEN not set');return;}
    if(!userId){console.warn('sendTgNotification: userId is empty');return;}
    const p=fetch(`https://api.telegram.org/bot${process.env.BOT_TOKEN}/sendMessage`,{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({chat_id:String(userId),text:message,parse_mode:'HTML',...PLAY_BUTTON}),
    }).then(async res=>{
      const json=await res.json().catch(()=>({}));
      if(!res.ok||!json.ok){
        console.error('sendTgNotification FAILED userId:',userId,'status:',res.status,'tg_error:',json.description||'unknown');
      }
    }).catch(e=>console.error('sendTgNotification:',e.message));
    await p;
  }catch(e){console.error('sendTgNotification:',e.message);}
}
const sendWelcomeNotification=sendTgNotification;

const CORS={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'GET, POST, OPTIONS','Access-Control-Allow-Headers':'Content-Type, Authorization, X-Action','Access-Control-Max-Age':'86400'};
const JSON_CT={'Content-Type':'application/json',...CORS};
const jRes=(b,s=200)=>new Response(JSON.stringify(b),{status:s,headers:JSON_CT});
const ok=d=>jRes({success:true,data:d});
const fail=(m,s=400)=>jRes({success:false,error:m},s);

function sanitise(i){if(!i)return i;return i.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi,'').replace(/[<>]/g,m=>m==='<'?'&lt;':'&gt;');}

// Firebase helpers
function fbUrl(env,path){
  const b=process.env.FIREBASE_DATABASE_URL?.replace(/\/$/,'');
  if(!b)throw new Error('FIREBASE_DATABASE_URL not set');
  const k=process.env.FIREBASE_API_KEY;
  if(!k)throw new Error('FIREBASE_API_KEY not set');
  return `${b}/${path.replace(/^\//,'')}.json?key=${k}`;
}
async function dbGet(env,path){try{const r=await fetch(fbUrl(env,path));if(!r.ok)throw new Error(`GET ${r.status}`);return{success:true,data:await r.json()};}catch(e){console.error('DB GET',path,e.message);return{success:false,error:e.message};}}
async function dbSet(env,path,data){try{const r=await fetch(fbUrl(env,path),{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});if(!r.ok)throw new Error(`SET ${r.status}`);return{success:true};}catch(e){console.error('DB SET',path,e.message);return{success:false,error:e.message};}}
async function dbUpdate(env,path,updates){try{const r=await fetch(fbUrl(env,path),{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify(updates)});if(!r.ok)throw new Error(`UPDATE ${r.status}`);return{success:true};}catch(e){console.error('DB UPDATE',path,e.message);return{success:false,error:e.message};}}
async function dbPush(env,path,data){try{const r=await fetch(fbUrl(env,path),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});if(!r.ok)throw new Error(`PUSH ${r.status}`);const j=await r.json();return{success:true,data:{id:j.name}};}catch(e){console.error('DB PUSH',path,e.message);return{success:false,error:e.message};}}
async function dbDelete(env,path){try{const r=await fetch(fbUrl(env,path),{method:'DELETE'});if(!r.ok)throw new Error(`DELETE ${r.status}`);return{success:true};}catch(e){console.error('DB DELETE',path,e.message);return{success:false,error:e.message};}}

// Rate limiter
const _rl=new Map();
function rateOk(ip){const now=Date.now();const d=_rl.get(ip)||{c:0,r:now+60000};if(now>d.r){d.c=0;d.r=now+60000;}d.c++;_rl.set(ip,d);return d.c<=60;}

// Per-user per-action cooldown
const _userActionTs=new Map();
const ACTION_COOLDOWNS={withdraw:5000,claimTask:2500,verifyTask:2500,createTask:5000,buyBike:2500,upgradeStats:2500,deposit:2500,startBikeMining:2500,claimBikeMining:2500,raceResult:4000,raceJoinQueue:1500,racePoll:400,raceCancelQueue:1500,raceAck:800,claimMissionTask:2500,submitPartnerPost:5000,saveSeasonAlloc:10000,saveLanguage:2000};
function userActionOk(uid,action){const cd=ACTION_COOLDOWNS[action];if(!cd)return true;const key=`${uid}:${action}`;const now=Date.now();const last=_userActionTs.get(key)||0;if(now-last<cd)return false;_userActionTs.set(key,now);return true;}

// Logging
const BALANCE_CHANGE_EVENTS=new Set(['withdraw_request','deposit_completed','claim_task','verify_task','create_task','admin_set_balance','admin_confirm_deposit','referral_commission','buy_bike','upgrade_stats','bike_mining_start','bike_mining_claim','claim_mission_task','partner_post_reward']);
function log(env,uid,type,details={},meta={}){
  if(!BALANCE_CHANGE_EVENTS.has(type))return;
  const ts=Date.now();const date=new Date(ts).toISOString();
  const entry={ts,date,type,...details};
  dbPush(env,`users/${uid}/log`,entry).catch(e=>console.error('LOG ERROR:',e.message));
}

// Telegram validation
async function validateTg(initData,botToken){
  try{
    if(!initData)return{valid:false,error:'No init data'};
    const p=new URLSearchParams(initData);
    const startParam=(p.get('start_param')||'').replace(/\D/g,'');
    if(!botToken){const u=p.get('user');if(!u)return{valid:false,error:'No user'};return{valid:true,user:JSON.parse(decodeURIComponent(u)),startParam};}
    const hash=p.get('hash');if(!hash)return{valid:false,error:'No hash'};
    p.delete('hash');
    const authDate=parseInt(p.get('auth_date')||'0');
    if(Date.now()/1000-authDate>900)return{valid:false,error:'Expired'};
    const dc=[...p.entries()].sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>`${k}=${v}`).join('\n');
    const secretKey=createHmac('sha256','WebAppData').update(botToken).digest();
    const hex=createHmac('sha256',secretKey).update(dc).digest('hex');
    if(hex!==hash)return{valid:false,error:'Bad hash'};
    const u=p.get('user');if(!u)return{valid:false,error:'No user'};
    return{valid:true,user:JSON.parse(decodeURIComponent(u)),startParam};
  }catch(e){return{valid:false,error:e.message};}
}

function extractStartParam(initDataStr){
  try{
    const p=new URLSearchParams(initDataStr||'');
    const sp=p.get('start_param');
    if(sp)return sp.replace(/\D/g,'');
    const userRaw=p.get('user');
    if(userRaw){const u=JSON.parse(decodeURIComponent(userRaw));if(u.start_param)return String(u.start_param).replace(/\D/g,'');}
  }catch(_){}
  return '';
}

async function registerReferral(env,uid,user,referrerId,ctx){
  try{
    const rr=await dbGet(env,`users/${referrerId}/referrals`);
    const refs=rr.data||{};
    if(!refs[uid]){
      await dbSet(env,`users/${referrerId}/referrals/${uid}`,{userId:uid,firstName:user.firstName,lastName:user.lastName,username:user.username,photoUrl:user.photoUrl,joinedAt:Date.now(),earned:0,hasWithdrawn:false});
      const notifKey=`notifSent/ref_${uid}_${referrerId}`;
      const already=await dbGet(env,notifKey);
      if(!already.data){
        const myTs=Date.now();
        await dbSet(env,notifKey,{ts:myTs,by:uid});
        await new Promise(r=>setTimeout(r,150));
        const confirm=await dbGet(env,notifKey);
        if(confirm.data&&confirm.data.ts===myTs){
          const refName=(user.firstName||'Someone').slice(0,32);
          const refLang=await getUserLang(env,referrerId);
          // Send directly — already executing inside waitUntil from hGetState
          await sendTgNotification(env,referrerId,m('ref_joined',refLang,refName));
        }
      }
    }
  }catch(e){console.error('registerReferral:',e.message);}
}

function makeUser(uid,tg={},ref=null){
  return{
    userId:uid,
    firstName:(tg.first_name||'').slice(0,64),
    lastName:(tg.last_name||'').slice(0,64),
    username:(tg.username||'').slice(0,64),
    photoUrl:(tg.photo_url||'').slice(0,512),
    tonBalance:0,
    hasDeposited:false,
    hasWithdrawn:false,
    ownedBikes:[],
    bikeUpgrades:{},
    bikeMining:{},
    totalBikesBought:0,
    totalRacesPlayed:0,
    totalMiningRuns:0,
    referralCode:String(uid),
    referredBy:ref||null,
    completedTasks:[],
    completedMissions:[],
    withdrawWallet:null,
    createdAt:Date.now(),
    welcomeBonusGiven:true,
    ownedBikes:[0],
  };
}

// ── getState ─────────────────────────────────────────────────────
async function hGetState(env,uid,tg,data={},_meta={},ctx=null){
  try{
    const rawRef=(
      data?._startParam||
      extractStartParam(data?._initData||'')||
      (data?.start_param||'').toString().replace(/\D/g,'')
    ).replace(/\D/g,'');
    const ref=rawRef&&rawRef!==uid?rawRef:null;

    const ur=await dbGet(env,`users/${uid}`);let user=ur.data;
    seedPartnerTasks(env).catch(()=>{});

    if(!user){
      user=makeUser(uid,tg,ref);
      await dbSet(env,`users/${uid}`,user);
      // Run referral registration + welcome notification in background
      if(ctx&&ctx.waitUntil)ctx.waitUntil((async()=>{
        try{
          // Register referral AFTER user is saved
          if(user.referredBy)await registerReferral(env,uid,user,user.referredBy,ctx);
          // Welcome notification is always sent in English
          const b0=BIKE_BASE_STATS[0];
          const d0=BIKE_DAILY_TON[0];
          await sendWelcomeNotification(env,uid,m('welcome_bike','en',BIKE_NAMES[0],b0.speed,b0.nitro,b0.accel,b0.maneuver,d0,G.MIN_WITHDRAW_TON));
        }catch(_){}
      })().catch(()=>{}));
    }else{
      if(tg){
        if(tg.first_name)user.firstName=tg.first_name.slice(0,64);
        if(tg.last_name) user.lastName=tg.last_name.slice(0,64);
        if(tg.username)  user.username=tg.username.slice(0,64);
        if(tg.photo_url) user.photoUrl=tg.photo_url.slice(0,512);
      }
      user.bikeMining=user.bikeMining||{};
      await dbUpdate(env,`users/${uid}`,{
        firstName:user.firstName,lastName:user.lastName,
        username:user.username,photoUrl:user.photoUrl,
        bikeMining:user.bikeMining,
      });
    }
    const settled=await settleBikeMining(env,uid,user,_meta,ctx);
    user=settled.user;
    const rr=await dbGet(env,`users/${uid}/referrals`);
    const refList=Object.values(rr.data||{});
    // Active referral = one who has made a withdrawal
    const referrals=await Promise.all(refList.map(async r=>{
      let hasWithdrawn=r.hasWithdrawn||false;
      let hasDeposited=r.hasDeposited||false;
      if(!hasWithdrawn){
        const ud=await dbGet(env,`users/${r.userId}/hasWithdrawn`);
        hasWithdrawn=ud.data===true;
        if(hasWithdrawn)await dbUpdate(env,`users/${uid}/referrals/${r.userId}`,{hasWithdrawn:true}).catch(()=>{});
      }
      if(!hasDeposited){
        const ud=await dbGet(env,`users/${r.userId}/hasDeposited`);
        hasDeposited=ud.data===true;
        if(hasDeposited)await dbUpdate(env,`users/${uid}/referrals/${r.userId}`,{hasDeposited:true}).catch(()=>{});
      }
      // Active = deposited OR withdrawn
      const isActive = hasWithdrawn || hasDeposited;
      return{userId:r.userId,name:`${r.firstName||''} ${r.lastName||''}`.trim()||'Friend',photo:r.photoUrl||null,date:r.joinedAt?new Date(r.joinedAt).toLocaleDateString():'',earned:r.earned||0,hasWithdrawn:isActive,hasDeposited:isActive};
    }));
    const wr=await dbGet(env,`users/${uid}/wdHistory`);
    const wdHistory=wr.data?Object.values(wr.data).sort((a,b)=>b.ts-a.ts).slice(0,10):[];
    const lr=await dbGet(env,`users/${uid}/log`);
    const balanceLog=lr.data?Object.values(lr.data).sort((a,b)=>b.ts-a.ts).slice(0,20).map(e=>({ts:e.ts,type:e.type,amount:e.amount,balance:e.balance})):[];
    // Fetch partner + community tasks to return to frontend
    const [tPartnerR,tCommunityR]=await Promise.all([
      dbGet(env,'tasks/partner'),
      dbGet(env,'tasks/community'),
    ]);
    const partnerTasksList=tPartnerR.data?Object.values(tPartnerR.data).filter(t=>t.status==='active'):[];
    const communityTasksList=tCommunityR.data?Object.values(tCommunityR.data).filter(t=>t.status==='active'):[];
    return{success:true,data:{
      user:{
        tonBalance:user.tonBalance||0,
        hasDeposited:user.hasDeposited||false,
        hasWithdrawn:user.hasWithdrawn||false,
        ownedBikes:user.ownedBikes||[],
        bikeUpgrades:user.bikeUpgrades||{},
        bikeMining:user.bikeMining||{},
        totalBikesBought:user.totalBikesBought||0,
        totalRacesPlayed:user.totalRacesPlayed||0,
        totalMiningRuns:user.totalMiningRuns||0,
        withdrawWallet:user.withdrawWallet||null,
        firstName:user.firstName||'',
        lastName:user.lastName||'',
        username:user.username||'',
        photoUrl:user.photoUrl||'',
        referralCode:user.referralCode||uid,
        referredBy:user.referredBy||null,
      },
      referrals,
      completedTasks:user.completedTasks||[],
      completedMissions:user.completedMissions||[],
      wdHistory,
      balanceLog,
      tasks:{partner:partnerTasksList,community:communityTasksList},
    }};
  }catch(e){console.error('getState',e);return{success:false,error:e.message,errorCode:'GET_STATE_ERROR'};}
}

// ── Buy Bike ─────────────────────────────────────────────────────
async function hBuyBike(env,uid,data,_meta={},ctx=null){
  try{
    const lv=parseInt(data.lv)||0;
    const bike=BIKE_BASE_STATS[lv];
    if(!bike)return{success:false,error:'Unknown bike level'};
    const r=await dbGet(env,`users/${uid}`);const user=r.data;
    if(!user)return{success:false,error:'User not found'};
    const owned=(user.ownedBikes||[]).map(Number);
    if(owned.includes(lv))return{success:false,error:'Bike already owned'};
    const priceTon=bike.price;
    if((user.tonBalance||0)<priceTon)return{success:false,error:`Need ${priceTon} TON. Your balance: ${(user.tonBalance||0).toFixed(4)} TON`};
    const newTon=Math.round(((user.tonBalance||0)-priceTon)*1e8)/1e8;
    const newOwned=[...owned,lv];
    const newTotal=(user.totalBikesBought||0)+1;
    await dbUpdate(env,`users/${uid}`,{tonBalance:newTon,ownedBikes:newOwned,totalBikesBought:newTotal});
    log(env,uid,'buy_bike',{bikeLevel:lv,price:priceTon,tonBalance_before:user.tonBalance||0,tonBalance_after:newTon},_meta);
    const _bkNames=BIKE_NAMES;
    const _bkDaily=BIKE_DAILY_TON[lv]||0;
    if(ctx&&ctx.waitUntil)ctx.waitUntil((async()=>{const _ul=await getUserLang(env,uid);await sendTgNotification(env,uid,m('bike_bought',_ul,_bkNames[lv]||'Level '+lv,lv,bike.speed,bike.nitro,bike.accel,bike.maneuver,_bkDaily,(_bkDaily*30).toFixed(4)));})().catch(()=>{}));
    if(user.referredBy&&user.referredBy!==uid){
      // Fix: use toFixed(8) to avoid Math.round zeroing small commissions
      const comm=parseFloat((priceTon*G.REF_BONUS_PCT/100).toFixed(8));
      if(comm>0){
        const rr=await dbGet(env,`users/${user.referredBy}`);
        if(rr.data){
          const newRefBal=parseFloat(((rr.data.tonBalance||0)+comm).toFixed(8));
          await dbUpdate(env,`users/${user.referredBy}`,{tonBalance:newRefBal});
          // Update earned field in referrer's referrals list
          const refEntry=await dbGet(env,`users/${user.referredBy}/referrals/${uid}`);
          const prevEarned=parseFloat((refEntry.data&&refEntry.data.earned)||0);
          const newEarned=parseFloat((prevEarned+comm).toFixed(8));
          // Use dbSet (PUT) to ensure the earned field is always written even if entry is stale
          if(refEntry.data){
            await dbSet(env,`users/${user.referredBy}/referrals/${uid}`,{...refEntry.data,earned:newEarned});
          } else {
            // Create referral entry if missing (edge case: old users without entry)
            await dbSet(env,`users/${user.referredBy}/referrals/${uid}`,{userId:uid,firstName:user.firstName||'',lastName:user.lastName||'',username:user.username||'',photoUrl:user.photoUrl||'',joinedAt:Date.now(),earned:newEarned,hasWithdrawn:user.hasWithdrawn||false});
          }
          log(env,user.referredBy,'referral_commission',{from:uid,bikeLevel:lv,bikePriceTon:priceTon,comm,tonBalance_before:rr.data.tonBalance||0,tonBalance_after:newRefBal},_meta);
          if(ctx&&ctx.waitUntil)ctx.waitUntil((async()=>{const _rl=await getUserLang(env,user.referredBy);await sendTgNotification(env,user.referredBy,m('ref_commission',_rl,user.firstName||'Friend',lv,comm.toFixed(4),newRefBal.toFixed(4)));})().catch(()=>{}));
        }else{
          console.error('hBuyBike: referredBy user not found:',user.referredBy);
        }
      }
    }
    return{success:true,data:{tonBalance:newTon,ownedBikes:newOwned,totalBikesBought:newTotal}};
  }catch(e){return{success:false,error:e.message};}
}

// ── Upgrade Bike Stats ──────────────────────────────────────────
async function hUpgradeStats(env,uid,data,_meta={},ctx=null){
  try{
    const{bikeLevel,stat}=data;
    const lv=parseInt(bikeLevel)||0;
    const validStats=['speed','nitro','accel','maneuver'];
    if(!validStats.includes(stat))return{success:false,error:'Invalid stat'};
    const bike=BIKE_BASE_STATS[lv];
    if(!bike)return{success:false,error:'Unknown bike'};
    const r=await dbGet(env,`users/${uid}`);const user=r.data;
    if(!user)return{success:false,error:'User not found'};
    if(!(user.ownedBikes||[]).map(Number).includes(lv))return{success:false,error:'Bike not owned'};
    const upgPrice=bike.price/4;
    if((user.tonBalance||0)<upgPrice)return{success:false,error:`Need ${upgPrice} TON`};
    const upgs=user.bikeUpgrades||{};
    const bikeUpgs=upgs[lv]||{speed:0,nitro:0,accel:0,maneuver:0};
    const inc=G.UPGRADE_INCREMENTS[stat]||5;
    const maxAdd=bike[stat];
    const maxUpgrades=Math.floor(maxAdd/inc);
    const curUpgrades=bikeUpgs[stat]||0;
    if(curUpgrades>=maxUpgrades)return{success:false,error:'Already at maximum level'};
    const oldStatVal=bike[stat]+curUpgrades*inc;
    const newStatVal=oldStatVal+inc;
    bikeUpgs[stat]=(curUpgrades+1);
    upgs[lv]=bikeUpgs;
    const newTon=(user.tonBalance||0)-upgPrice;
    await dbUpdate(env,`users/${uid}`,{tonBalance:newTon,bikeUpgrades:upgs});
    log(env,uid,'upgrade_stats',{bikeLevel:lv,stat,upgradeCount:bikeUpgs[stat],upgPrice,tonBalance_before:user.tonBalance||0,tonBalance_after:newTon},_meta);
    if(ctx&&ctx.waitUntil)ctx.waitUntil((async()=>{
      const _ul=await getUserLang(env,uid);
      const STAT_NAMES={
        ar:{speed:'السرعة',nitro:'النيترو',accel:'التسارع',maneuver:'المناورة'},
        en:{speed:'Speed',nitro:'Nitro',accel:'Acceleration',maneuver:'Handling'},
        ru:{speed:'Скорость',nitro:'Нитро',accel:'Ускорение',maneuver:'Управление'},
        es:{speed:'Velocidad',nitro:'Nitro',accel:'Aceleración',maneuver:'Manejo'},
        fr:{speed:'Vitesse',nitro:'Nitro',accel:'Accélération',maneuver:'Maniabilité'},
      };
      const statName=(STAT_NAMES[_ul]||STAT_NAMES.en)[stat]||stat;
      await sendTgNotification(env,uid,m('bike_upgraded',_ul,lv,statName,oldStatVal,newStatVal,inc,upgPrice));
    })().catch(()=>{}));
    return{success:true,data:{tonBalance:newTon,bikeUpgrades:upgs,newUpgradeCount:bikeUpgs[stat]}};
  }catch(e){return{success:false,error:e.message};}
}

async function settleBikeMining(env,uid,user,_meta={},ctx=null){
  const mining=user.bikeMining||{};
  const now=Date.now();
  let tonAdded=0;
  const completed=[];
  let changed=false;
  for(const [lv,rec] of Object.entries(mining)){
    if(rec&&rec.status==='active'&&(rec.endsAt||0)<=now){
      const reward=parseFloat(rec.reward||BIKE_DAILY_TON[lv]||0);
      if(reward>0){tonAdded+=reward;completed.push({bikeLevel:Number(lv),reward});}
      mining[lv]={...rec,status:'idle',claimedAt:now,lastReward:reward};
      changed=true;
    }
  }
  if(!changed)return{user,bikeMining:mining,tonAdded:0,completed:[]};
  const newTon=parseFloat(((user.tonBalance||0)+tonAdded).toFixed(8));
  await dbUpdate(env,`users/${uid}`,{tonBalance:newTon,bikeMining:mining});
  log(env,uid,'bike_mining_claim',{ton_reward:tonAdded,completed,tonBalance_before:user.tonBalance||0,tonBalance_after:newTon},_meta);
  if(ctx&&ctx.waitUntil)ctx.waitUntil((async()=>{const _ml=await getUserLang(env,uid);await sendTgNotification(env,uid,m('mining_done',_ml,tonAdded.toFixed(4)));})().catch(()=>{}));
  return{user:{...user,tonBalance:newTon,bikeMining:mining},bikeMining:mining,tonAdded,completed};
}

async function hStartBikeMining(env,uid,data,_meta={},ctx=null){
  try{
    const lvRaw=parseInt(data.bikeLevel,10);
    const lv=Number.isFinite(lvRaw)?lvRaw:NaN;
    if(!Object.prototype.hasOwnProperty.call(BIKE_BASE_STATS,lv))return{success:false,error:'Unknown bike'};
    const r=await dbGet(env,`users/${uid}`);let user=r.data;
    if(!user)return{success:false,error:'User not found'};
    const settled=await settleBikeMining(env,uid,user,_meta,ctx);
    user=settled.user;
    const owned=(user.ownedBikes||[]).map(Number);
    if(!owned.includes(lv))return{success:false,error:'Bike not owned'};
    const mining=user.bikeMining||{};
    const cur=mining[String(lv)]||mining[lv];
    const now=Date.now();
    if(cur&&cur.status==='active'&&(cur.endsAt||0)>now)return{success:false,error:'Bike is already mining'};
    const reward=BIKE_DAILY_TON[lv]||0;
    const rec={bikeLevel:lv,status:'active',startedAt:now,endsAt:now+BIKE_MINING_MS,reward};
    mining[String(lv)]=rec;
    const newMiningRuns=(user.totalMiningRuns||0)+1;
    await dbUpdate(env,`users/${uid}`,{bikeMining:mining,totalMiningRuns:newMiningRuns});
    log(env,uid,'bike_mining_start',{bikeLevel:lv,reward,startsAt:now,endsAt:rec.endsAt},_meta);
    return{success:true,data:{bikeMining:mining,started:rec,settledTon:settled.tonAdded||0,tonBalance:user.tonBalance||0,totalMiningRuns:newMiningRuns}};
  }catch(e){return{success:false,error:e.message};}
}

async function hClaimBikeMining(env,uid,_data,_meta={},ctx=null){
  try{
    const r=await dbGet(env,`users/${uid}`);const user=r.data;
    if(!user)return{success:false,error:'User not found'};
    const settled=await settleBikeMining(env,uid,user,_meta,ctx);
    return{success:true,data:{bikeMining:settled.bikeMining,tonAdded:settled.tonAdded,completed:settled.completed,tonBalance:settled.user.tonBalance||0}};
  }catch(e){return{success:false,error:e.message};}
}

// ── Withdraw ─────────────────────────────────────────────────────
async function hWithdraw(env,uid,data,_meta={}){
  try{
    const addr=(data.address||'').trim();const amt=parseFloat(data.amount)||0;
    if(!addr||addr.length<10)return{success:false,error:'Invalid TON address'};
    if(amt<G.MIN_WITHDRAW_TON)return{success:false,error:`Minimum withdrawal is ${G.MIN_WITHDRAW_TON} TON`};
    if(amt>100000)return{success:false,error:'Amount too large'};
    
    // Check wallet uniqueness — prevent multi-account abuse
    const safeAddr=addr.replace(/[^a-zA-Z0-9_-]/g,'_').slice(0,120);
    const addrRec=await dbGet(env,`walletAddresses/${safeAddr}`);
    if(addrRec.data&&addrRec.data.uid&&addrRec.data.uid!==uid){
      return{success:false,error:'WALLET_USED',errorCode:'WALLET_USED'};
    }

    const lockKey=`withdrawLocks/${uid}`;
    const lockRec=await dbGet(env,lockKey);
    const now=Date.now();
    if(lockRec.data&&(now-(lockRec.data.ts||0))<60000)return{success:false,error:'A withdrawal is already being processed. Please wait 60 seconds.'};
    await dbSet(env,lockKey,{ts:now,uid});
    try{
      const r=await dbGet(env,`users/${uid}`);const user=r.data;
      if(!user){await dbSet(env,lockKey,{ts:0});return{success:false,error:'User not found'};}
      if((user.tonBalance||0)<amt){await dbSet(env,lockKey,{ts:0});return{success:false,error:'Insufficient TON balance'};}
      if((now-(user._lastWdTs||0))<60000){await dbSet(env,lockKey,{ts:0});return{success:false,error:'Please wait 60 seconds before next withdrawal'};}
      
      // Check for existing pending withdrawal
      const wdHistRec=await dbGet(env,`users/${uid}/wdHistory`);
      const wdHistMap=wdHistRec.data||{};
      const hasPendingWd=Object.values(wdHistMap).some(w=>w&&w.status==='pending');
      if(hasPendingWd){await dbSet(env,lockKey,{ts:0});return{success:false,error:'You already have a pending withdrawal. Please wait for it to be processed before creating a new one.',errorCode:'PENDING_WITHDRAW_EXISTS'};}
      
      const tpr=await dbGet(env,'tasks/partner');
      const partnerTasks=tpr.data?Object.values(tpr.data).filter(t=>t.status==='active'):[];
      const completedTasks=user.completedTasks||[];
      const missingPartner=partnerTasks.filter(t=>!completedTasks.includes(t.id));
      if(missingPartner.length>0){await dbSet(env,lockKey,{ts:0});return{success:false,error:'Complete all partner tasks first',errorCode:'PARTNER_TASKS_REQUIRED',missing:missingPartner.length};}
      
      const wdId=`wd_${uid}_${now}`;
      // Apply 10% withdrawal fee
      const feeAmt=parseFloat((amt*G.WITHDRAW_FEE_PCT/100).toFixed(8));
      const netAmt=parseFloat((amt-feeAmt).toFixed(8));
      const upd={tonBalance:parseFloat(((user.tonBalance||0)-amt).toFixed(8)),_lastWdTs:now,hasWithdrawn:true,withdrawWallet:addr};
      await dbUpdate(env,`users/${uid}`,upd);
      
      // Register wallet address
      if(!addrRec.data)await dbSet(env,`walletAddresses/${safeAddr}`,{uid,ts:now});
      
      const rec={wdId,userId:uid,address:addr,amt:netAmt,amtRequested:amt,fee:feeAmt,status:'pending',ts:now};
      await dbSet(env,`users/${uid}/wdHistory/${wdId}`,rec);
      await dbSet(env,`withdrawQueue/${wdId}`,rec);
      
      // Mark referral as active (has deposited or withdrawn)
      if(user.referredBy){
        await dbUpdate(env,`users/${user.referredBy}/referrals/${uid}`,{hasWithdrawn:true,hasDeposited:true}).catch(()=>{});
      }
      
      log(env,uid,'withdraw_request',{wdId,amount_requested:amt,fee:feeAmt,amount_net:netAmt,address:addr,tonBalance_before:user.tonBalance||0,tonBalance_after:upd.tonBalance},_meta);
      await dbSet(env,lockKey,{ts:0});
      return{success:true,data:{wdId,tonBalance:upd.tonBalance,netAmt,feeAmt,status:'pending'}};
    }catch(innerErr){await dbSet(env,lockKey,{ts:0}).catch(()=>{});throw innerErr;}
  }catch(e){return{success:false,error:e.message};}
}

// ── Deposit ──────────────────────────────────────────────────────
async function hDeposit(env,uid,data,_meta={}){
  try{
    const amt=parseFloat(data.amount)||0;const txHash=(data.txHash||'').slice(0,256);
    if(!txHash||amt<G.MIN_DEPOSIT_TON)return{success:false,error:'Invalid deposit data'};
    const safeHash=txHash.replace(/[^a-zA-Z0-9]/g,'_');
    const dup=await dbGet(env,`txHashes/${safeHash}`);
    if(dup.data)return{success:false,error:'Duplicate transaction'};
    const depId=`dep_${uid}_${Date.now()}`;
    const rec={depId,userId:uid,txHash,amount:amt,status:'pending',ts:Date.now()};
    await dbSet(env,`users/${uid}/deposits/${depId}`,rec);
    await dbSet(env,`pendingDeposits/${depId}`,rec);
    await dbSet(env,`txHashes/${safeHash}`,{depId,userId:uid,ts:Date.now()});
    return{success:true,data:{depositId:depId,message:'Transaction registered. Your TON balance will be added within 3 minutes.'}};
  }catch(e){return{success:false,error:e.message};}
}

// ── Claim Task (social/partner) ───────────────────────────────────
async function hClaimTask(env,uid,data,_meta={},ctx=null){
  try{
    const tid=data.taskId;
    const lockKey=`taskLocks/${uid}_${tid}`;
    const lockRec=await dbGet(env,lockKey);
    const now=Date.now();
    if(lockRec.data&&(now-(lockRec.data.ts||0))<30000)return{success:false,error:'Already processing.'};
    await dbSet(env,lockKey,{ts:now});
    try{
      const r=await dbGet(env,`users/${uid}`);const user=r.data;
      if(!user){await dbSet(env,lockKey,{ts:0});return{success:false,error:'User not found'};}
      if((user.completedTasks||[]).includes(tid)){await dbSet(env,lockKey,{ts:0});return{success:false,error:'Already claimed'};}
      let tonReward=0;
      if(G.REF_TON_TASKS[tid]){
        const t=G.REF_TON_TASKS[tid];
        const rr=await dbGet(env,`users/${uid}/referrals`);
        const refIds=rr.data?Object.keys(rr.data):[];
        let activeCount=0;
        for(const refId of refIds){
          const hw=await dbGet(env,`users/${refId}/hasWithdrawn`);
          const hd=await dbGet(env,`users/${refId}/hasDeposited`);
          if(hw.data===true||hd.data===true)activeCount++;
        }
        if(activeCount<t.n){await dbSet(env,lockKey,{ts:0});return{success:false,error:`Need ${t.n} active referrals (who have withdrawn)`};}
        tonReward=t.ton;
      }else{
        // Unknown task - still mark completed (e.g. social tasks)
        await dbUpdate(env,`users/${uid}`,{completedTasks:[...(user.completedTasks||[]),tid]});
        await dbSet(env,lockKey,{ts:0});
        return{success:true,data:{tonBalance:user.tonBalance||0,tonAdded:0}};
      }
      const newTon=(user.tonBalance||0)+tonReward;
      await dbUpdate(env,`users/${uid}`,{completedTasks:[...(user.completedTasks||[]),tid],tonBalance:parseFloat(newTon.toFixed(8))});
      log(env,uid,'claim_task',{taskId:tid,ton_reward:tonReward,tonBalance_before:user.tonBalance||0,tonBalance_after:newTon},_meta);
      const _rtn={rt10:'10 Active Refs',rt50:'50 Active Refs',rt100:'100 Active Refs',rt200:'200 Active Refs',rt500:'500 Active Refs',rt1000:'1000 Active Refs'};
      if(ctx&&ctx.waitUntil)ctx.waitUntil((async()=>{const _tl=await getUserLang(env,uid);await sendTgNotification(env,uid,m('task_done',_tl,_rtn[tid]||tid,tonReward));})().catch(()=>{}));
      await dbSet(env,lockKey,{ts:0});
      return{success:true,data:{tonBalance:parseFloat(newTon.toFixed(8)),tonAdded:tonReward}};
    }catch(innerErr){await dbSet(env,lockKey,{ts:0}).catch(()=>{});throw innerErr;}
  }catch(e){return{success:false,error:e.message};}
}

// ── Claim Mission Task (bikes/races/mining) ───────────────────────
async function hClaimMissionTask(env,uid,data,_meta={},ctx=null){
  try{
    const tid=data.taskId;
    const lockKey=`missionLocks/${uid}_${tid}`;
    const lockRec=await dbGet(env,lockKey);
    const now=Date.now();
    if(lockRec.data&&(now-(lockRec.data.ts||0))<30000)return{success:false,error:'Already processing.'};
    await dbSet(env,lockKey,{ts:now});
    try{
      const r=await dbGet(env,`users/${uid}`);const user=r.data;
      if(!user){await dbSet(env,lockKey,{ts:0});return{success:false,error:'User not found'};}
      if((user.completedMissions||[]).includes(tid)){await dbSet(env,lockKey,{ts:0});return{success:false,error:'Mission already claimed'};}
      let tonReward=0;
      let meetsReq=false;
      if(G.BIKE_TASKS[tid]){
        const t=G.BIKE_TASKS[tid];
        if((user.totalBikesBought||0)>=t.n){meetsReq=true;tonReward=t.ton;}
        else{await dbSet(env,lockKey,{ts:0});return{success:false,error:`Need ${t.n} bikes purchased (you have ${user.totalBikesBought||0})`};}
      }else if(G.RACE_TASKS[tid]){
        const t=G.RACE_TASKS[tid];
        if((user.totalRacesPlayed||0)>=t.n){meetsReq=true;tonReward=t.ton;}
        else{await dbSet(env,lockKey,{ts:0});return{success:false,error:`Need ${t.n} races played (you have ${user.totalRacesPlayed||0})`};}
      }else if(G.MINE_TASKS[tid]){
        const t=G.MINE_TASKS[tid];
        if((user.totalMiningRuns||0)>=t.n){meetsReq=true;tonReward=t.ton;}
        else{await dbSet(env,lockKey,{ts:0});return{success:false,error:`Need ${t.n} mining runs (you have ${user.totalMiningRuns||0})`};}
      }else{
        await dbSet(env,lockKey,{ts:0});
        return{success:false,error:'Unknown mission'};
      }
      const newTon=(user.tonBalance||0)+tonReward;
      await dbUpdate(env,`users/${uid}`,{
        completedMissions:[...(user.completedMissions||[]),tid],
        tonBalance:parseFloat(newTon.toFixed(8))
      });
      log(env,uid,'claim_mission_task',{taskId:tid,ton_reward:tonReward,tonBalance_before:user.tonBalance||0,tonBalance_after:newTon},_meta);
      const _mn={bt5:'Buy 5 Bikes',bt10:'Buy 10 Bikes',rc10:'10 Races',rc20:'20 Races',rc50:'50 Races',mt20:'20 Mining Runs',mt50:'50 Mining Runs'};
      if(ctx&&ctx.waitUntil)ctx.waitUntil((async()=>{const _msl=await getUserLang(env,uid);await sendTgNotification(env,uid,m('mission_done',_msl,_mn[tid]||tid,tonReward));})().catch(()=>{}));
      await dbSet(env,lockKey,{ts:0});
      return{success:true,data:{tonBalance:parseFloat(newTon.toFixed(8)),tonAdded:tonReward}};
    }catch(innerErr){await dbSet(env,lockKey,{ts:0}).catch(()=>{});throw innerErr;}
  }catch(e){return{success:false,error:e.message};}
}

// ── Submit Partner Post ───────────────────────────────────────────
async function hSubmitPartnerPost(env,uid,data,_meta={}){
  try{
    const link=(data.link||'').trim();
    if(!link||link.length<10)return{success:false,error:'Invalid post link'};
    const postId=`pp_${uid}_${Date.now()}`;
    const rec={postId,userId:uid,link,status:'pending',reward:0,ts:Date.now()};
    await dbSet(env,`users/${uid}/partnerPosts/${postId}`,rec);
    await dbSet(env,`partnerPostQueue/${postId}`,rec);
    return{success:true,data:{postId,status:'pending'}};
  }catch(e){return{success:false,error:e.message};}
}

// ── Check Membership ──────────────────────────────────────────────
async function checkMembership(env,uid,link){
  try{
    if(!process.env.BOT_TOKEN)return true;
    let username=link.split('t.me/')[1]?.split('?')[0]?.split('/')[0];
    if(!username)return false;
    if(!username.startsWith('@'))username='@'+username;
    const res=await fetch(`https://api.telegram.org/bot${process.env.BOT_TOKEN}/getChatMember?chat_id=${encodeURIComponent(username)}&user_id=${uid}`);
    if(!res.ok)return false;
    const j=await res.json();
    if(!j.ok)return false;
    return['member','administrator','creator'].includes(j.result?.status||'left');
  }catch(e){console.error('checkMembership:',e.message);return false;}
}

// ── Verify Task ───────────────────────────────────────────────────
async function hVerifyTask(env,uid,data,_meta={}){
  try{
    const{taskId,taskType,taskCategory}=data;
    const taskCat=taskCategory||'partner';
    const tr=await dbGet(env,`tasks/${taskCat}/${taskId}`);const task=tr.data;
    if(!task)return{success:false,error:'Task not found'};
    if(task.status!=='active')return{success:false,error:'Task no longer active'};
    const ur=await dbGet(env,`users/${uid}`);const u=ur.data||{};
    if((u.completedTasks||[]).includes(taskId))return{success:false,error:'Task already completed'};
    if((task.completedBy||[]).includes(uid))return{success:false,error:'Task already completed'};
    if(task.type==='channel'){const isMember=await checkMembership(env,uid,task.link);if(!isMember)return{success:false,error:'Not a member. Join first!'};}
    const newCompletions=(task.completions||0)+1;
    const newCompletedBy=[...(task.completedBy||[]),uid];
    const taskUpdates={completions:newCompletions,completedBy:newCompletedBy,updatedAt:Date.now()};
    if(task.targetUsers!=null&&newCompletions>=(task.targetUsers||Infinity))taskUpdates.status='completed';
    await dbUpdate(env,`tasks/${taskCat}/${taskId}`,taskUpdates);
    const newCompleted=[...(u.completedTasks||[]),taskId];
    await dbUpdate(env,`users/${uid}`,{completedTasks:newCompleted});
    log(env,uid,'verify_task',{taskId,taskType:task.type,taskCategory:taskCat},_meta);
    return{success:true,data:{completions:newCompletions}};
  }catch(e){console.error('verifyTask:',e);return{success:false,error:e.message};}
}

// ── Create Task ───────────────────────────────────────────────────
async function hCreateTask(env,uid,data,_meta={}){
  try{
    const{type,link,targetUsers}=data;
    if(!['channel','bot'].includes(type))return{success:false,error:'Invalid type'};
    const target=parseInt(targetUsers)||0;
    if(target<100)return{success:false,error:'Minimum target is 100 users'};
    if(target>100000)return{success:false,error:'Maximum target is 100,000 users'};
    if(!link||!link.includes('t.me/'))return{success:false,error:'Valid Telegram link required'};
    const COST_PER_USER=0.0006; // TON per user
    const cost=target*COST_PER_USER;
    const ur=await dbGet(env,`users/${uid}`);const u=ur.data;
    if(!u)return{success:false,error:'User not found'};
    if((u.tonBalance||0)<cost)return{success:false,error:`Insufficient TON. Need ${cost} TON`};
    await dbUpdate(env,`users/${uid}`,{tonBalance:(u.tonBalance||0)-cost});
    const username=link.split('t.me/')[1]?.split('?')[0]?.split('/')[0]||link;
    const now=Date.now();
    const taskId=`task_${now}_${Math.random().toString(36).substring(2,10)}`;
    const taskData={id:taskId,creatorId:uid,type,link,name:`@${username}`,targetUsers:target,completions:0,completedBy:[],status:'active',createdAt:now,expiresAt:now+(30*24*60*60*1000),updatedAt:now};
    await dbSet(env,`tasks/community/${taskId}`,taskData);
    log(env,uid,'create_task',{taskId,taskType:type,targetUsers:target,cost_ton:cost,tonBalance_before:(u.tonBalance||0)+cost,tonBalance_after:(u.tonBalance||0)},_meta);
    return{success:true,data:{taskId,type,targetUsers:target,totalCost:cost}};
  }catch(e){console.error('createTask:',e);return{success:false,error:e.message};}
}

// ── Race (PvP) ─────────────────────────────────────────────────────
// Server-authoritative matchmaking. Frontend has zero trust on outcome.
const RACE_COST=0.5, RACE_PRIZE=0.9, RACE_MATCH_TTL=5*60*1000;

function _bikePower(user, lv){
  const base=BIKE_BASE_STATS[lv]; if(!base) return {total:0,maxKmh:0};
  const upg=(user.bikeUpgrades||{})[String(lv)]||(user.bikeUpgrades||{})[lv]||{};
  const s=base.speed   +(upg.speed   ||0)*G.UPGRADE_INCREMENTS.speed;
  const n=base.nitro   +(upg.nitro   ||0)*G.UPGRADE_INCREMENTS.nitro;
  const a=base.accel   +(upg.accel   ||0)*G.UPGRADE_INCREMENTS.accel;
  const m=base.maneuver+(upg.maneuver||0)*G.UPGRADE_INCREMENTS.maneuver;
  const total=s+n+a+m;
  return {total, maxKmh:Math.min(500, Math.max(35, Math.round(total/2)))};
}

// Deprecated: legacy single-player handler. Now a no-op so old clients
// can't credit themselves any prize. PvP outcome is decided in raceJoinQueue.
async function hRaceResult(env,uid,_data,_meta={}){
  try{
    const r=await dbGet(env,`users/${uid}`);
    return{success:true,data:{success:true,data:{tonBalance:r.data?.tonBalance||0,deprecated:true}}};
  }catch(e){return{success:false,error:e.message};}
}

// Join (or create) the matchmaking queue. Always charges 0.5 TON up-front.
async function hRaceJoinQueue(env,uid,data,_meta={},ctx=null){
  try{
    const lvRaw=parseInt(data.bikeLevel,10);
    const lv=Number.isFinite(lvRaw)?lvRaw:NaN;
    if(!Object.prototype.hasOwnProperty.call(BIKE_BASE_STATS,lv)) return{success:false,error:'Invalid bike level'};
    if(lv===0) return{success:false,error:'Free bike is not allowed in races. Use a paid bike to race against others.'};
    const ru=await dbGet(env,`users/${uid}`); let user=ru.data;
    if(!user) return{success:false,error:'User not found'};
    const owned=(user.ownedBikes||[]).map(Number);
    if(!owned.includes(lv)) return{success:false,error:'You do not own this bike'};
    const rec=(user.bikeMining||{})[String(lv)]||(user.bikeMining||{})[lv];
    if(rec&&rec.status==='active'&&(rec.endsAt||0)>Date.now()) return{success:false,error:'This bike is mining now'};
    // Already in a match? Return it only if the match record still exists; clear stale pointers.
    const am=await dbGet(env,`userActiveMatch/${uid}`);
    if(am.data){
      const mr=await dbGet(env,`raceMatches/${am.data}`);
      // Stale match detection: if older than 5 min, force-clean it
      if(mr.data && (Date.now()-(mr.data.createdAt||0))<300000){
        return{success:true,data:{status:'matched',matchId:am.data}};
      }
      await dbDelete(env,`userActiveMatch/${uid}`);
      if(mr.data) await dbDelete(env,`raceMatches/${am.data}`).catch(()=>{});
    }
    // Already queued? Keep fresh queue entries, but clear stale ones so old data doesn't block new races.
    const exQ=await dbGet(env,`raceQueue/${uid}`);
    if(exQ.data){
      if(Date.now()-(exQ.data.joinedAt||0)>RACE_MATCH_TTL){
        const refundBal=parseFloat(((user.tonBalance||0)+RACE_COST).toFixed(4));
        await Promise.all([
          dbDelete(env,`raceQueue/${uid}`),
          dbUpdate(env,`users/${uid}`,{tonBalance:refundBal})
        ]);
        user={...user,tonBalance:refundBal};
      }else{
        return{success:true,data:{status:'waiting'}};
      }
    }
    if((user.tonBalance||0)<RACE_COST) return{success:false,error:'Insufficient TON balance (need 0.5)'};
    // Charge entry fee
    const balAfter=parseFloat(((user.tonBalance||0)-RACE_COST).toFixed(4));
    await dbUpdate(env,`users/${uid}`,{tonBalance:balAfter});
    const power=_bikePower(user,lv);
    const me={uid,lv,power:power.total,maxKmh:power.maxKmh,
      name:(user.firstName||'Player').slice(0,32),
      username:(user.username||'').slice(0,32),
      photoUrl:(user.photoUrl||'').slice(0,512),
      joinedAt:Date.now()};
    // Scan queue for an opponent (skip stale > TTL, enforce ±2 bike-level cap)
    const qall=await dbGet(env,'raceQueue'); const queue=qall.data||{};
    let opp=null;
    for(const k of Object.keys(queue)){
      if(k===uid) continue;
      const q=queue[k]; if(!q||!q.uid||q.uid===uid) continue;
      if(Date.now()-(q.joinedAt||0)>RACE_MATCH_TTL){ await dbDelete(env,`raceQueue/${k}`); continue; }
      opp=q; break;
    }
    if(opp){
      // Claim opponent via lock + confirm pattern (prevents double-match races)
      const lockKey=`raceLocks/${opp.uid}`; const lockTs=Date.now();
      await dbSet(env,lockKey,{byUid:uid,ts:lockTs});
      await new Promise(r=>setTimeout(r,150));
      const cf=await dbGet(env,lockKey);
      if(!cf.data||cf.data.byUid!==uid||cf.data.ts!==lockTs){
        await dbSet(env,`raceQueue/${uid}`,me);
        return{success:true,data:{status:'waiting'}};
      }
      const oppQ=await dbGet(env,`raceQueue/${opp.uid}`);
      if(!oppQ.data){
        await dbDelete(env,lockKey);
        await dbSet(env,`raceQueue/${uid}`,me);
        return{success:true,data:{status:'waiting'}};
      }
      // Decide winner: higher power; ties -> random
      const winnerUid = me.power>opp.power ? uid
                      : opp.power>me.power ? opp.uid
                      : (Math.random()<0.5?uid:opp.uid);
      const matchId=`m_${Date.now()}_${Math.random().toString(36).slice(2,9)}`;
      // p1 = waiting player (left lane), p2 = joining player (right lane)
      const match={
        matchId, createdAt:Date.now(),
        winnerUid, prize:RACE_PRIZE, cost:RACE_COST,
        p1:{uid:opp.uid,lv:opp.lv,name:opp.name,username:opp.username||'',photoUrl:opp.photoUrl||'',maxKmh:opp.maxKmh,power:opp.power},
        p2:{uid:me.uid, lv:me.lv, name:me.name, username:me.username||'',  photoUrl:me.photoUrl||'',  maxKmh:me.maxKmh, power:me.power},
        ack:{}
      };
      await dbSet(env,`raceMatches/${matchId}`,match);
      await Promise.all([
        dbSet(env,`userActiveMatch/${opp.uid}`,matchId),
        dbSet(env,`userActiveMatch/${uid}`,matchId),
        dbDelete(env,`raceQueue/${opp.uid}`),
        dbDelete(env,lockKey)
      ]);
      // Pre-credit winner immediately
      const loserUid=winnerUid===uid?opp.uid:uid;
      const [wRef,lRef]=await Promise.all([
        dbGet(env,`users/${winnerUid}`),
        dbGet(env,`users/${loserUid}`)
      ]);
      const updates=[];
      if(wRef.data){
        const newBal=parseFloat(((wRef.data.tonBalance||0)+RACE_PRIZE).toFixed(4));
        updates.push(dbUpdate(env,`users/${winnerUid}`,{tonBalance:newBal,totalRacesPlayed:(wRef.data.totalRacesPlayed||0)+1}));
      }
      if(lRef.data){
        updates.push(dbUpdate(env,`users/${loserUid}`,{totalRacesPlayed:(lRef.data.totalRacesPlayed||0)+1}));
      }
      await Promise.all(updates);
      log(env,uid,    'race_result',{won:winnerUid===uid,    cost:RACE_COST,prize:winnerUid===uid?    RACE_PRIZE:0,matchId,opponent:opp.uid},_meta);
      log(env,opp.uid,'race_result',{won:winnerUid===opp.uid,cost:RACE_COST,prize:winnerUid===opp.uid?RACE_PRIZE:0,matchId,opponent:uid},_meta);
      // Store notification intent in the match record — sent after race finishes via raceAck
      // This prevents the bot message from arriving before the race animation even starts
      await dbUpdate(env,`raceMatches/${matchId}`,{
        notifPending:{
          winnerUid,
          winnerName: winnerUid===uid ? (me.name||'You') : (opp.name||'Opponent'),
          loserName:  winnerUid===uid ? (opp.name||'Opponent') : (me.name||'You'),
          winnerPhone: winnerUid===uid ? uid : opp.uid,
          loserPhone:  winnerUid===uid ? opp.uid : uid,
        }
      });
      return{success:true,data:{status:'matched',matchId}};
    }
    // No opponent yet → enter queue
    await dbSet(env,`raceQueue/${uid}`,me);
    return{success:true,data:{status:'waiting'}};
  }catch(e){console.error('raceJoinQueue:',e);return{success:false,error:e.message};}
}

// Poll queue / match state. Returns idle | waiting | matched.
async function hRacePoll(env,uid,_data,_meta={}){
  try{
    const am=await dbGet(env,`userActiveMatch/${uid}`);
    if(am.data){
      const mr=await dbGet(env,`raceMatches/${am.data}`);
      // Stale match: older than 5 minutes with no ack → force-clean & return idle
      // Use 5 min (not 60s) so the opponent has enough time to poll and get matched data
      if(mr.data && (Date.now()-(mr.data.createdAt||0))>300000){
        await dbDelete(env,`userActiveMatch/${uid}`).catch(()=>{});
        await dbDelete(env,`raceMatches/${am.data}`).catch(()=>{});
        return{success:true,data:{status:'idle'}};
      }
      if(mr.data){
        const m=mr.data;
        const youAreP1 = m.p1.uid===uid;
        const you = youAreP1 ? m.p1 : m.p2;
        const opp = youAreP1 ? m.p2 : m.p1;
        const ur=await dbGet(env,`users/${uid}`);
        return{success:true,data:{
          status:'matched', matchId:m.matchId,
          youWon: m.winnerUid===uid,
          youAreP1, prize:m.prize,
          you:{uid:you.uid,lv:you.lv,name:you.name,username:you.username,photoUrl:you.photoUrl,maxKmh:you.maxKmh},
          opp:{uid:opp.uid,lv:opp.lv,name:opp.name,username:opp.username,photoUrl:opp.photoUrl,maxKmh:opp.maxKmh},
          tonBalance: ur.data?.tonBalance||0
        }};
      }
      // Stale pointer (match record already deleted) — clear and return idle
      await dbDelete(env,`userActiveMatch/${uid}`);
    }
    const q=await dbGet(env,`raceQueue/${uid}`);
    if(q.data){
      const waitedMs=Date.now()-(q.data.joinedAt||0);
      if(waitedMs>RACE_MATCH_TTL){
        await dbDelete(env,`raceQueue/${uid}`);
        const u=await dbGet(env,`users/${uid}`);
        if(u.data){
          const newBal=parseFloat(((u.data.tonBalance||0)+RACE_COST).toFixed(4));
          await dbUpdate(env,`users/${uid}`,{tonBalance:newBal});
          return{success:true,data:{status:'idle',refunded:true,tonBalance:newBal}};
        }
        return{success:true,data:{status:'idle',refunded:true}};
      }
      return{success:true,data:{status:'waiting'}};
    }
    return{success:true,data:{status:'idle'}};
  }catch(e){console.error('racePoll:',e);return{success:false,error:e.message};}
}

// Cancel queue (only allowed while still waiting). Refunds the 0.5 TON.
async function hRaceCancelQueue(env,uid,_data,_meta={}){
  try{
    const am=await dbGet(env,`userActiveMatch/${uid}`);
    if(am.data) return{success:false,error:'Match already started, cannot cancel'};
    const q=await dbGet(env,`raceQueue/${uid}`);
    if(!q.data) return{success:true,data:{refunded:false}};
    await dbDelete(env,`raceQueue/${uid}`);
    const u=await dbGet(env,`users/${uid}`);
    if(u.data){
      const newBal=parseFloat(((u.data.tonBalance||0)+RACE_COST).toFixed(4));
      await dbUpdate(env,`users/${uid}`,{tonBalance:newBal});
      return{success:true,data:{refunded:true,tonBalance:newBal}};
    }
    return{success:true,data:{refunded:true}};
  }catch(e){console.error('raceCancelQueue:',e);return{success:false,error:e.message};}
}

// Acknowledge match seen — clears the active-match pointer for this user.
// First player to ack sends the Telegram notifications (race is now truly finished).
// Both players must ack before the match record is deleted.
async function hRaceAck(env,uid,_data,_meta={},ctx=null){
  try{
    const am=await dbGet(env,`userActiveMatch/${uid}`);
    if(!am.data) return{success:true,data:{cleared:true}};
    const matchId=am.data;
    await dbDelete(env,`userActiveMatch/${uid}`);
    const mr=await dbGet(env,`raceMatches/${matchId}`);
    if(mr.data){
      const mch=mr.data;
      const otherUid = mch.p1.uid===uid ? mch.p2.uid : mch.p1.uid;
      // Send Telegram notifications on FIRST ack (race animation has now finished)
      const notif=mch.notifPending;
      if(notif&&!mch.notifSent){
        // Mark sent first to prevent double-send if both players ack simultaneously
        await dbUpdate(env,`raceMatches/${matchId}`,{notifSent:true}).catch(()=>{});
        const winnerUid=notif.winnerUid;
        const loserUid =winnerUid===mch.p1.uid ? mch.p2.uid : mch.p1.uid;
        const winnerName=notif.winnerName||'Winner';
        const loserName =notif.loserName||'Opponent';
        const [_wl,_ll]=await Promise.all([getUserLang(env,winnerUid),getUserLang(env,loserUid)]);
        if(ctx&&ctx.waitUntil)ctx.waitUntil((async()=>{
          await Promise.all([
            sendTgNotification(env,winnerUid,m('race_won',_wl,loserName,RACE_PRIZE)),
            sendTgNotification(env,loserUid,m('race_lost',_ll,winnerName,RACE_COST,RACE_PRIZE)),
          ]);
        })().catch(()=>{}));
      }
      // Check if other player already acked — if so, delete the match record
      const otherActive=await dbGet(env,`userActiveMatch/${otherUid}`);
      if(!otherActive.data){
        // Other player already cleared their pointer — safe to delete match
        await dbDelete(env,`raceMatches/${matchId}`).catch(()=>{});
      }
      // Also clear other pointer to prevent them being stuck if they never ack
      await dbDelete(env,`userActiveMatch/${otherUid}`).catch(()=>{});
    }
    return{success:true,data:{cleared:true}};
  }catch(e){console.error('raceAck:',e);return{success:false,error:e.message};}
}


async function hAdmin(env,action,data,ctx=null){
  switch(action){
    case 'adminGetUser':{const r=await dbGet(env,`users/${data.userId}`);return{success:true,data:r.data||null};}
    case 'adminSetBalance':{
      const r=await dbGet(env,`users/${data.userId}`);if(!r.data)return{success:false,error:'Not found'};
      const u={};
      if(data.tonBalance!==undefined)u.tonBalance=Math.max(0,parseFloat(data.tonBalance));
      await dbUpdate(env,`users/${data.userId}`,u);
      log(env,data.userId,'admin_set_balance',{ton_set:data.tonBalance,by:'admin'});
      return{success:true};
    }
    case 'adminConfirmDeposit':{
      const dep=await dbGet(env,`users/${data.userId}/deposits/${data.depositId}`);
      if(!dep.data)return{success:false,error:'Not found'};
      const ton=parseFloat(data.amount||dep.data.amount);
      await dbUpdate(env,`users/${data.userId}/deposits/${data.depositId}`,{status:'completed',completedAt:Date.now()});
      const u=await dbGet(env,`users/${data.userId}`);
      if(u.data){await dbUpdate(env,`users/${data.userId}`,{tonBalance:(u.data.tonBalance||0)+ton,hasDeposited:true});
        // Mark referral active on deposit
        if(u.data.referredBy)await dbUpdate(env,`users/${u.data.referredBy}/referrals/${data.userId}`,{hasDeposited:true}).catch(()=>{});
      }
      await dbDelete(env,`pendingDeposits/${data.depositId}`);
      log(env,data.userId,'admin_confirm_deposit',{depositId:data.depositId,amount_ton:ton,by:'admin'});
      return{success:true,data:{tonAdded:ton}};
    }
    case 'adminApproveWithdraw':{
      const r=await dbGet(env,`withdrawQueue/${data.wdId}`);if(!r.data)return{success:false,error:'Not found'};
      await dbUpdate(env,`withdrawQueue/${data.wdId}`,{status:'approved'});
      await dbUpdate(env,`users/${r.data.userId}/wdHistory/${data.wdId}`,{status:'approved'});
      if(ctx&&ctx.waitUntil)ctx.waitUntil((async()=>{const _wdl=await getUserLang(env,r.data.userId);await sendTgNotification(env,r.data.userId,m('wd_approved',_wdl,r.data.amt));})().catch(()=>{}));
      return{success:true};
    }
    case 'adminRejectWithdraw':{
      const r=await dbGet(env,`withdrawQueue/${data.wdId}`);if(!r.data)return{success:false,error:'Not found'};
      await dbUpdate(env,`withdrawQueue/${data.wdId}`,{status:'rejected'});
      await dbUpdate(env,`users/${r.data.userId}/wdHistory/${data.wdId}`,{status:'rejected'});
      const u=await dbGet(env,`users/${r.data.userId}`);
      if(u.data)await dbUpdate(env,`users/${r.data.userId}`,{tonBalance:(u.data.tonBalance||0)+r.data.amt});
      if(ctx&&ctx.waitUntil)ctx.waitUntil((async()=>{const _rjl=await getUserLang(env,r.data.userId);await sendTgNotification(env,r.data.userId,m('wd_rejected',_rjl,r.data.amt));})().catch(()=>{}));
      return{success:true};
    }
    case 'adminGetQueue':{const q=await dbGet(env,'withdrawQueue');return{success:true,data:q.data||{}};}
    case 'adminApprovePartnerPost':{
      const r=await dbGet(env,`partnerPostQueue/${data.postId}`);if(!r.data)return{success:false,error:'Not found'};
      const reward=parseFloat(data.reward)||0;
      await dbUpdate(env,`partnerPostQueue/${data.postId}`,{status:'approved',reward});
      await dbUpdate(env,`users/${r.data.userId}/partnerPosts/${data.postId}`,{status:'approved',reward});
      if(reward>0){
        const u=await dbGet(env,`users/${r.data.userId}`);
        if(u.data)await dbUpdate(env,`users/${r.data.userId}`,{tonBalance:(u.data.tonBalance||0)+reward});
        if(ctx&&ctx.waitUntil)ctx.waitUntil((async()=>{const _pl=await getUserLang(env,r.data.userId);await sendTgNotification(env,r.data.userId,m('post_approved',_pl,reward));})().catch(()=>{}));
        log(env,r.data.userId,'partner_post_reward',{postId:data.postId,reward,by:'admin'});
      }
      return{success:true};
    }
    case 'adminRejectPartnerPost':{
      const r=await dbGet(env,`partnerPostQueue/${data.postId}`);if(!r.data)return{success:false,error:'Not found'};
      await dbUpdate(env,`partnerPostQueue/${data.postId}`,{status:'rejected'});
      await dbUpdate(env,`users/${r.data.userId}/partnerPosts/${data.postId}`,{status:'rejected'});
      if(ctx&&ctx.waitUntil)ctx.waitUntil((async()=>{const _prl=await getUserLang(env,r.data.userId);await sendTgNotification(env,r.data.userId,m('post_rejected',_prl));})().catch(()=>{}));
      return{success:true};
    }
    default:return{success:false,error:'Unknown admin action'};
  }
}

// ── Save Season Allocation ────────────────────────────────────────
async function hSaveSeasonAlloc(env,uid,data,_meta={}){
  try{
    const{coinsAlloc,refsAlloc,total}=data;
    await dbSet(env,`users/${uid}/seasonAlloc`,{coinsAlloc:coinsAlloc||0,refsAlloc:refsAlloc||0,total:total||0,savedAt:Date.now()});
    return{success:true,data:{saved:true}};
  }catch(e){console.error('saveSeasonAlloc:',e);return{success:false,error:e.message};}
}

// ── Express Routes (Railway) ──────────────────────────────────────
app.options('*', (req, res) => res.set(CORS).sendStatus(204));

app.get('/health', (req, res) => {
  res.set(CORS).json({ success: true, data: { status: 'ok', ts: Date.now(), env: process.env.ENVIRONMENT || 'production' } });
});

app.get('/tonconnect-manifest.json', (req, res) => {
  res.set(CORS).json({ url: 'https://raseenracing.vercel.app', name: 'Rassen Racing', iconUrl: 'https://res.cloudinary.com/dktppfipy/image/upload/v1778675636/bd57c63b-71a1-4114-8207-3763fbab038f_xxeo3c.jpg', description: 'Raseen Racing Garage' });
});

app.post('/api', async (req, res) => {
  res.set(CORS);
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || 'unknown';
  if (!rateOk(ip)) return res.status(429).json({ success: false, error: 'Rate limit exceeded' });

  let body;
  try {
    const raw = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
    if (raw.length > 10240) return res.status(413).json({ success: false, error: 'Payload too large' });
    body = JSON.parse(sanitise(raw));
  } catch (_) { return res.status(400).json({ success: false, error: 'Invalid JSON' }); }

  const authHeader = req.headers['authorization'] || '';
  const action = req.headers['x-action'] || body.action;
  const data = body.data || {};
  if (!action) return res.status(400).json({ success: false, error: 'Missing action' });

  const ADMIN_ACTIONS = new Set(['adminGetUser','adminSetBalance','adminConfirmDeposit','adminApproveWithdraw','adminRejectWithdraw','adminGetQueue','adminApprovePartnerPost','adminRejectPartnerPost']);
  if (ADMIN_ACTIONS.has(action)) {
    const v = await validateTg(authHeader.replace('Telegram ', ''), process.env.BOT_TOKEN);
    if (!v.valid) return res.status(401).json({ success: false, error: 'Unauthorized' });
    const adminIds = (process.env.ADMIN_IDS || '').split(',').map(s => s.trim());
    if (!adminIds.includes(String(v.user?.id))) return res.status(403).json({ success: false, error: 'Forbidden' });
    return res.json(await hAdmin(env, action, data, ctx));
  }

  if (action === 'ping') return res.json({ success: true, data: { pong: true, ts: Date.now() } });
  if (!authHeader.startsWith('Telegram ')) return res.status(401).json({ success: false, error: 'Telegram authentication required' });

  const v = await validateTg(authHeader.replace('Telegram ', ''), process.env.BOT_TOKEN);
  if (!v.valid) {
    console.error('TG validation failed:', v.error);
    return res.status(401).json({ success: false, error: 'Invalid Telegram authentication', errorCode: 'INVALID_TELEGRAM_AUTH', debug: { hasInitData: !!authHeader, botTokenConfigured: !!process.env.BOT_TOKEN, environment: process.env.ENVIRONMENT || 'production', validationError: v.error } });
  }

  const uid = String(v.user.id);
  const _meta = { ip, ua: req.headers['user-agent'] || '' };
  console.log(`[${new Date().toISOString()}] User:${uid} Action:${action} IP:${ip}`);

  if (!userActionOk(uid, action)) return res.status(429).json({ success: false, error: 'Too fast. Please wait a moment.' });

  let result;
  switch (action) {
    case 'saveLanguage':      result = await (async()=>{const lang=(data.lang||'en');if(['ar','en','ru','es','fr'].includes(lang)){await dbSet(env,`users/${uid}/language`,lang);}return{success:true};})(); break;
    case 'getState':          result = await hGetState(env,uid,v.user,{...data,_startParam:v.startParam||''},_meta,ctx); break;
    case 'withdraw':          result = await hWithdraw(env,uid,data,_meta); break;
    case 'deposit':           result = await hDeposit(env,uid,data,_meta); break;
    case 'claimTask':         result = await hClaimTask(env,uid,data,_meta,ctx); break;
    case 'verifyTask':        result = await hVerifyTask(env,uid,data,_meta); break;
    case 'createTask':        result = await hCreateTask(env,uid,data,_meta); break;
    case 'buyBike':           result = await hBuyBike(env,uid,data,_meta,ctx); break;
    case 'upgradeStats':      result = await hUpgradeStats(env,uid,data,_meta,ctx); break;
    case 'startBikeMining':   result = await hStartBikeMining(env,uid,data,_meta,ctx); break;
    case 'claimBikeMining':   result = await hClaimBikeMining(env,uid,data,_meta,ctx); break;
    case 'raceResult':        result = await hRaceResult(env,uid,data,_meta); break;
    case 'raceJoinQueue':     result = await hRaceJoinQueue(env,uid,data,_meta,ctx); break;
    case 'racePoll':          result = await hRacePoll(env,uid,data,_meta); break;
    case 'raceCancelQueue':   result = await hRaceCancelQueue(env,uid,data,_meta); break;
    case 'raceAck':           result = await hRaceAck(env,uid,data,_meta,ctx); break;
    case 'claimMissionTask':  result = await hClaimMissionTask(env,uid,data,_meta,ctx); break;
    case 'submitPartnerPost': result = await hSubmitPartnerPost(env,uid,data,_meta); break;
    case 'saveSeasonAlloc':   result = await hSaveSeasonAlloc(env,uid,data,_meta); break;
    default: return res.status(400).json({ success: false, error: 'Unknown action' });
  }
  res.json(result);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`RaseenRacing server running on port ${PORT}`));
