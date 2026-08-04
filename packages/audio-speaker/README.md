# audio-speaker

> Output audio data to speaker in browser/node.

`audio-speaker` is the unscoped alias of [`@audio/speaker`](https://npmjs.org/package/@audio/speaker) — same code, same releases. Both names are maintained; the scope is canonical and hosts the per-platform binary packages (`@audio/speaker-darwin-arm64`, `@audio/speaker-linux-x64`, …).

```js
import speaker from 'audio-speaker'

let write = speaker({ sampleRate: 44100, channels: 2 })
write(pcmBuffer)
write(null) // end
```

Full docs: [@audio/speaker](https://github.com/audiojs/speaker).
