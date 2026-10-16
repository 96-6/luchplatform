// Device names are browser reports, not attestation. Never use these flags for grades.
// Sources and false-positive/rename limitations: docs/MEETINGS.md.
const cameraRules: [string, RegExp][] = [
  [
    'OBS Virtual Camera',
    /\bobs[\s_-]*(?:studio[\s_-]*)?(?:virtual[\s_-]*cam(?:era)?|camera|cam)\b/i,
  ],
  ['NVIDIA Broadcast', /\bnvidia\s+broadcast\b/i],
  ['ManyCam', /\bmanycam\b/i],
  ['XSplit', /\bxsplit(?:\s+(?:vcam|broadcaster))?\b/i],
  ['SplitCam', /\bsplitcam\b/i],
  ['NDI Webcam Input', /\bndi\b.*\b(?:webcam|video|virtual|camera)\b/i],
  ['Snap Camera', /\bsnap\s+camera\b/i],
  ['Camo', /\b(?:reincubate\s+)?camo\b/i],
  ['mmhmm', /\bmmhmm\b/i],
  ['Unity Capture', /\bunity\s*(?:video\s*)?capture\b/i],
  ['v4l2loopback / akvcam', /\b(?:v4l2loopback|akvcam)\b/i],
  ['Virtual camera', /\bvirtual[\s_-]*(?:web[\s_-]*)?cam(?:era)?\b/i],
];
const microphoneRules: [string, RegExp][] = [
  ['NVIDIA Broadcast / RTX Voice', /\b(?:nvidia\s+broadcast|(?:nvidia\s+)?rtx\s+voice)\b/i],
  [
    'VB-Audio / VB-CABLE',
    /\b(?:vb[\s_-]*audio|vb[\s_-]*cable|cable(?:-[ab])?\s+(?:output|input))\b/i,
  ],
  ['Voicemeeter', /\bvoicemeeter\b/i],
  ['Virtual Audio Cable', /\bvirtual\s+audio\s+cable\b/i],
  ['BlackHole', /\bblackhole(?:\s+\d+ch)?\b/i],
  ['Loopback', /\bloopback(?:\s+audio)?\b/i],
  ['Soundflower', /\bsoundflower\b/i],
  ['ManyCam', /\bmanycam\b/i],
  ['NDI Audio', /\bndi\b.*\b(?:audio|microphone|input)\b/i],
  ['Voicemod / Voice.ai', /\b(?:voicemod|voice\.ai)\b/i],
  ['Krisp', /\bkrisp\b/i],
  ['SteelSeries Sonar', /\b(?:steelseries\s+)?sonar\s*(?:microphone|stream|virtual)\b/i],
  ['Elgato Wave Link', /\b(?:elgato\s+)?wave\s+link\b/i],
  ['Virtual microphone', /\bvirtual[\s_-]*(?:microphone|mic|audio[\s_-]*(?:device|input))\b/i],
];
export function classifyDevice(kind: 'camera' | 'microphone', label: string) {
  const normalized = label.normalize('NFKC').replace(/\s+/g, ' ').trim();
  return (
    (kind === 'camera' ? cameraRules : microphoneRules).find(([, pattern]) =>
      pattern.test(normalized),
    )?.[0] ?? null
  );
}
