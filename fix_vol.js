const fs = require('fs');
let content = fs.readFileSync('src/bot.ts', 'utf8');

content = content.replace(/oppSignal\.marketRegime === "LOW_VOLATILITY"/g, '(["LOW_VOL_NO_TRADE", "DEAD_LOW_VOLATILITY"].includes(oppSignal.marketRegime || ""))');
content = content.replace(/signal\.marketRegime === "LOW_VOLATILITY"/g, '(["LOW_VOL_NO_TRADE", "DEAD_LOW_VOLATILITY"].includes(signal.marketRegime || ""))');
content = content.replace(/optRegime === "LOW_VOLATILITY"/g, '(["LOW_VOL_NO_TRADE", "DEAD_LOW_VOLATILITY"].includes(optRegime))');
content = content.replace(/regime === "LOW_VOLATILITY"/g, '(["LOW_VOL_NO_TRADE", "DEAD_LOW_VOLATILITY"].includes(regime))');
content = content.replace(/regimeName === "LOW_VOLATILITY"/g, '(["LOW_VOL_NO_TRADE", "DEAD_LOW_VOLATILITY"].includes(regimeName))');

content = content.replace(/rejectionReason = "LOW_VOLATILITY"/g, 'rejectionReason = "LOW_VOL_NO_TRADE"');
content = content.replace(/candRejection = "LOW_VOLATILITY"/g, 'candRejection = "LOW_VOL_NO_TRADE"');
content = content.replace(/waitingReason = "LOW_VOLATILITY"/g, 'waitingReason = "LOW_VOL_NO_TRADE"');
content = content.replace(/botState\.blocker = "LOW_VOLATILITY"/g, 'botState.blocker = "LOW_VOL_NO_TRADE"');

fs.writeFileSync('src/bot.ts', content);
console.log("Replaced LOW_VOLATILITY in bot.ts");
