// session-tips: first-party IRMS module. Runs inside the app WebView with no imports and no
// access beyond the ModuleContext the app passes in (see README "Module contract").
export default {
  activate(ctx) {
    ctx.registerTip('感測器請貼在大腿與小腿外側、盡量與腿平行;衣物墊高會讓角度偏差,重新跑校準精靈可修正。')
    ctx.registerTip('校準「勾小腿」時大腿保持不動,只把腳跟往後往上勾,幅度越大屈曲軸越準。')
    ctx.registerTip('抬大腿步驟需至少 20°,建議抬到 40–60° 並停住等待捕捉。')
    ctx.log(`session-tips activated on app ${ctx.appVersion}`)
  }
}
