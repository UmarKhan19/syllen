// One job per process: transcribe a 16 kHz mono WAV and stream NDJSON to stdout.
// The API is documented at https://github.com/Desert-Ant-Labs/desert-ant-core.
import { Voz } from "@desert-ant-labs/voz";
import * as ort from "onnxruntime-node";

const audioPath = process.argv[2];

function send(event) {
  process.stdout.write(JSON.stringify(event) + "\n");
}

if (!audioPath) {
  send({ type: "error", message: "usage: node server.mjs <audio.wav>" });
  process.exit(2);
}

try {
  const voz = await Voz.load({
    ort,
    onProgress: (fraction) => send({ type: "progress", phase: "model", fraction }),
  });
  const result = await voz.transcribe(audioPath, {
    onProgress: (fraction) => send({ type: "progress", phase: "transcribe", fraction }),
  });
  send({
    type: "result",
    text: result.text,
    words: result.words,
    duration: result.duration,
    realtimeFactor: result.realtimeFactor,
  });
} catch (error) {
  send({ type: "error", message: error?.stack ? String(error.stack) : String(error) });
  process.exitCode = 1;
}
