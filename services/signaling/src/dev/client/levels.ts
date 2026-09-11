type Node = {
  source: MediaStreamAudioSourceNode;
  analyser: AnalyserNode;
  data: Uint8Array<ArrayBuffer>;
};

/** One analyser per track; read() returns a 0..1 level per key for the tile meters. */
export class LevelMeter {
  private context: AudioContext | null = null;
  private readonly nodes = new Map<string, Node>();

  attach(key: string, track: MediaStreamTrack): void {
    if (track.kind !== "audio") return;
    this.detach(key);
    this.context ??= new AudioContext();
    // The first attach follows the join click, so the context may start; resume if it did not.
    if (this.context.state === "suspended") void this.context.resume();
    const source = this.context.createMediaStreamSource(new MediaStream([track]));
    const analyser = this.context.createAnalyser();
    analyser.fftSize = 256;
    source.connect(analyser);
    this.nodes.set(key, { source, analyser, data: new Uint8Array(analyser.frequencyBinCount) });
  }

  detach(key: string): void {
    const node = this.nodes.get(key);
    if (!node) return;
    node.source.disconnect();
    this.nodes.delete(key);
  }

  read(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [key, node] of this.nodes) {
      node.analyser.getByteTimeDomainData(node.data);
      let peak = 0;
      for (const sample of node.data) peak = Math.max(peak, Math.abs(sample - 128) / 128);
      out[key] = Math.min(1, peak * 1.5);
    }
    return out;
  }

  close(): void {
    for (const key of [...this.nodes.keys()]) this.detach(key);
    void this.context?.close();
    this.context = null;
  }
}
