/** Provider seams barrel: contracts + the CI-default fakes. */
export type {
  AnimationProvider,
  AnimationResult,
  AnimationStatus,
  AnimationSubmitInput,
  AudioSpec,
  GeneratedFrame,
  ImageGenerateOptions,
  ImageProvider,
  Providers,
  ProviderForKind,
  RenderClipInput,
  RenderComposition,
  RenderProvider,
  RenderResult,
  StorageProvider,
  StorageRange,
  StoredObject,
  TtsAudioSpec,
  UrlAudioSpec,
} from './types.ts';
export { NoopAnimationProvider, NoopImageProvider, NoopRenderProvider } from './noop.ts';
export {
  LocalFilesystemStorageProvider,
  type LocalStorageOptions,
} from './storage-local.ts';
export type {
  CheckoutSession,
  CreateCheckoutInput,
  CreditPack,
  PaymentProvider,
  PaymentWebhookResult,
} from './payments.ts';
export {
  NoopPaymentProvider,
  noopPaymentSignature,
  type NoopPaymentEvent,
} from './payments-noop.ts';
export {
  StaticVoicesProvider,
  STATIC_VOICES,
  type Voice,
  type VoicesProvider,
} from './voices.ts';
export {
  NoopVoGenerator,
  type VoGenerator,
  type VoGenerateInput,
} from './vo-gen.ts';
