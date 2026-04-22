import { WavRecorder, WavStreamPlayer } from "../wavtools";

import {
  RTVIClientOptions,
  RTVIEventCallbacks,
  RTVIMessage,
  Tracks,
} from "@pipecat-ai/client-js";

/** Translate a DOMException-like mic/cam error into a user-facing string. */
function _formatMediaError(err: unknown, kind: "mic" | "cam"): string {
  const name = (err as { name?: string } | null)?.name ?? "";
  const device = kind === "mic" ? "microphone" : "camera";
  switch (name) {
    case "NotAllowedError":
      return `${device[0].toUpperCase() + device.slice(1)} permission denied. Click the lock/permissions icon in the URL bar and allow ${device} access, then try again.`;
    case "NotFoundError":
      return `No ${device} was found on this device.`;
    case "NotReadableError":
      return `The ${device} is in use by another application. Close other apps using it and retry.`;
    case "OverconstrainedError":
      return `The selected ${device} is no longer available. Pick a different one from the menu.`;
    case "SecurityError":
      return `Browser blocked ${device} access because the page is not served over HTTPS.`;
    default: {
      const msg = (err as { message?: string } | null)?.message;
      return `Could not switch ${device}${msg ? `: ${msg}` : "."}`;
    }
  }
}

export abstract class MediaManager {
  declare protected _userAudioCallback: (data: ArrayBuffer) => void;
  declare protected _options: RTVIClientOptions;
  protected _callbacks: RTVIEventCallbacks = {};

  protected _micEnabled: boolean;
  protected _camEnabled: boolean;

  constructor() {
    this._micEnabled = true;
    this._camEnabled = false;
  }

  setUserAudioCallback(userAudioCallback: (data: ArrayBuffer) => void) {
    this._userAudioCallback = userAudioCallback;
  }
  setRTVIOptions(options: RTVIClientOptions, override: boolean = false) {
    if (this._options && !override) return;
    this._options = options;
    this._callbacks = options.callbacks ?? {};
    this._micEnabled = options.enableMic ?? true;
    this._camEnabled = options.enableCam ?? false;
  }

  abstract initialize(): Promise<void>;
  abstract connect(): Promise<void>;
  abstract disconnect(): Promise<void>;

  abstract userStartedSpeaking(): Promise<unknown>;
  abstract bufferBotAudio(
    data: ArrayBuffer | Int16Array,
    id?: string,
  ): Int16Array | undefined;

  abstract getAllMics(): Promise<MediaDeviceInfo[]>;
  abstract getAllCams(): Promise<MediaDeviceInfo[]>;
  abstract getAllSpeakers(): Promise<MediaDeviceInfo[]>;

  abstract updateMic(micId: string): Promise<void>;
  abstract updateCam(camId: string): Promise<void>;
  abstract updateSpeaker(speakerId: string): Promise<void>;

  abstract get selectedMic(): MediaDeviceInfo | Record<string, never>;
  abstract get selectedCam(): MediaDeviceInfo | Record<string, never>;
  abstract get selectedSpeaker(): MediaDeviceInfo | Record<string, never>;

  abstract enableMic(enable: boolean): void;
  abstract enableCam(enable: boolean): void;

  abstract get isCamEnabled(): boolean;
  abstract get isMicEnabled(): boolean;

  abstract tracks(): Tracks;
}

export class WavMediaManager extends MediaManager {
  private _wavRecorder;
  private _wavStreamPlayer;

  private _initialized = false;
  private _recorderChunkSize: number | undefined = undefined;

  constructor(
    recorderChunkSize: number | undefined = undefined,
    recorderSampleRate: number | undefined = 24000,
  ) {
    super();
    this._recorderChunkSize = recorderChunkSize;
    this._wavRecorder = new WavRecorder({ sampleRate: recorderSampleRate });
    this._wavStreamPlayer = new WavStreamPlayer({ sampleRate: 24000 });
  }

  async initialize(): Promise<void> {
    await this._wavRecorder.begin();
    this._wavRecorder.listenForDeviceChange(null);
    this._wavRecorder.listenForDeviceChange(
      this._handleAvailableDevicesUpdated.bind(this),
    );
    await this._wavStreamPlayer.connect();
    this._initialized = true;
  }

  async connect(): Promise<void> {
    if (!this._initialized) {
      await this.initialize();
    }
    const isAlreadyRecording = this._wavRecorder.getStatus() == "recording";
    if (this._micEnabled && !isAlreadyRecording) {
      await this._startRecording();
    }
  }

  async disconnect(): Promise<void> {
    if (!this._initialized) {
      return;
    }
    await this._wavRecorder.end();
    await this._wavStreamPlayer.interrupt();
    this._initialized = false;
  }

  async userStartedSpeaking(): Promise<unknown> {
    return this._wavStreamPlayer.interrupt();
  }

  bufferBotAudio(data: ArrayBuffer | Int16Array, id?: string): Int16Array {
    return this._wavStreamPlayer.add16BitPCM(data, id);
  }

  getAllMics(): Promise<MediaDeviceInfo[]> {
    return this._wavRecorder.listDevices();
  }
  getAllCams(): Promise<MediaDeviceInfo[]> {
    // TODO: Video not supported yet
    return Promise.resolve([]);
  }
  getAllSpeakers(): Promise<MediaDeviceInfo[]> {
    // TODO: Implement speaker support
    return Promise.resolve([]);
  }

  async updateMic(micId: string): Promise<void> {
    const prevMic = this._wavRecorder.deviceSelection;
    const prevMicId = prevMic?.deviceId;

    // Idempotent short-circuit — Firefox re-prompts for every deviceId change,
    // so avoid gratuitous churn when the user re-selects the current device.
    if (micId && prevMicId && micId === prevMicId) return;

    // WavRecorder holds at most one MediaStream, so we must end() before
    // begin(). That means a failure of begin() leaves the user silent. If the
    // new device fails, roll back to the previous one rather than leaving the
    // app muted, and surface the original error through the RTVI error channel.
    await this._wavRecorder.end();
    try {
      await this._wavRecorder.begin(micId);
      if (this._micEnabled) {
        await this._startRecording();
      }
      const curMic = this._wavRecorder.deviceSelection;
      if (curMic && prevMic && prevMic.label !== curMic.label) {
        this._callbacks.onMicUpdated?.(curMic);
      }
    } catch (err) {
      this._callbacks.onError?.(
        RTVIMessage.error(_formatMediaError(err, "mic")),
      );
      // Best-effort rollback: re-open the previous device so the user is not
      // left without audio. If the rollback itself fails (e.g. the previous
      // device was unplugged too), we just stay ended and let the UI re-prompt.
      if (prevMicId) {
        try {
          await this._wavRecorder.begin(prevMicId);
          if (this._micEnabled) await this._startRecording();
        } catch {
          // swallow: original error already surfaced above
        }
      }
      throw err;
    }
  }

  async updateCam(camId: string): Promise<void> {
    // TODO: Video not supported yet
  }
  async updateSpeaker(speakerId: string): Promise<void> {
    // TODO: Implement speaker support
  }

  get selectedMic(): MediaDeviceInfo | Record<string, never> {
    return this._wavRecorder.deviceSelection ?? {};
  }
  get selectedCam(): MediaDeviceInfo | Record<string, never> {
    // TODO: Video not supported yet
    return {};
  }
  get selectedSpeaker(): MediaDeviceInfo | Record<string, never> {
    // TODO: Implement speaker support
    return {};
  }

  async enableMic(enable: boolean): Promise<void> {
    this._micEnabled = enable;
    if (!this._wavRecorder.stream) return;
    this._wavRecorder.stream
      .getAudioTracks()
      .forEach((track: MediaStreamTrack) => {
        track.enabled = enable;
        if (!enable) {
          this._callbacks.onTrackStopped?.(track, localParticipant());
        }
      });
    if (enable) {
      await this._startRecording();
    } else {
      await this._wavRecorder.pause();
    }
  }
  enableCam(enable: boolean): void {
    // TODO: Video not supported yet
  }

  get isCamEnabled(): boolean {
    // TODO: Video not supported yet
    return false;
  }
  get isMicEnabled(): boolean {
    return this._micEnabled;
  }

  tracks(): Tracks {
    const tracks = this._wavRecorder.stream?.getTracks()[0];
    return { local: tracks ? { audio: tracks } : {} };
  }

  private async _startRecording() {
    await this._wavRecorder.record((data) => {
      const m = data.mono;
      const view = new Uint8Array(m.buffer, m.byteOffset, m.byteLength);
      const copy = new Uint8Array(view);
      this._userAudioCallback(copy.buffer);
    }, this._recorderChunkSize);
    const track = this._wavRecorder.stream?.getAudioTracks()[0];
    if (track) {
      this._callbacks.onTrackStarted?.(track, localParticipant());
    }
  }

  private _handleAvailableDevicesUpdated(devices: MediaDeviceInfo[]) {
    this._callbacks.onAvailableCamsUpdated?.(
      devices.filter((d) => d.kind === "videoinput"),
    );
    this._callbacks.onAvailableMicsUpdated?.(
      devices.filter((d) => d.kind === "audioinput"),
    );
    // if the current device went away or we're using the default and
    // the default changed, reset the mic.
    const defaultDevice = devices.find((d) => d.deviceId === "default");
    const currentDevice = this._wavRecorder.deviceSelection;
    if (
      currentDevice &&
      (!devices.some((d) => d.deviceId === currentDevice.deviceId) ||
        (currentDevice.deviceId === "default" &&
          currentDevice.label !== defaultDevice?.label))
    ) {
      // Fire-and-forget: we're inside a devicechange event handler with no
      // place to await. updateMic already surfaces failures via onError.
      void this.updateMic("").catch(() => {
        /* already reported via onError */
      });
    }
  }
}

const localParticipant = () => {
  return {
    id: "local",
    name: "",
    local: true,
  };
};
