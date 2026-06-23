// AudioWorklet：在专用音频线程把麦克风降采样到 16k PCM16，攒到一定量再 postMessage 回渲染主线程。
// 取代旧的 ScriptProcessorNode（跑在主线程、有固定延迟、界面一忙就卡，且已废弃）。
class PCMWorklet extends AudioWorkletProcessor {
  constructor() {
    super()
    this._acc = []
    this._ratio = sampleRate / 16000 // sampleRate 是 worklet 全局变量 = 当前音频上下文采样率
  }

  process(inputs) {
    const ch = inputs[0] && inputs[0][0]
    if (ch) {
      const outLen = Math.floor(ch.length / this._ratio)
      for (let i = 0; i < outLen; i++) {
        const s = ch[Math.floor(i * this._ratio)]
        this._acc.push(Math.max(-1, Math.min(1, s)) * 0x7fff)
      }
      // 攒到 ~80ms(1280 个 16k 采样)再发，控制 IPC 频率（与旧的 4096 块节奏相近）。
      if (this._acc.length >= 1280) {
        const out = Int16Array.from(this._acc)
        this._acc.length = 0
        this.port.postMessage(out.buffer, [out.buffer])
      }
    }
    return true // 持续处理；不写 outputs = 输出静音，不会把麦克风回授到扬声器
  }
}

registerProcessor('pcm-worklet', PCMWorklet)
