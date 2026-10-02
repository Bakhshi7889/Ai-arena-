import { PLATFORMS, aspectRatio, isAspectCompatible } from './specs.js';

/**
 * Decide what each network should receive.
 *
 * Returns one entry per requested target describing either the source file
 * (`variant: 'source'`) or a transcode Posterly will produce. Pure function —
 * no I/O — so the whole decision table is unit-testable.
 *
 * @param {{width?:number,height?:number,durationMs?:number,size?:number,mime?:string}} source
 * @param {Array<{provider:string, format?:string}>} targets
 * @param {{ffmpegAvailable?:boolean, autoReframe?:boolean}} options
 */
export function planVariants(source, targets, { ffmpegAvailable = false, autoReframe = true } = {}) {
  const sourceAspect = aspectRatio(source.width, source.height);
  const durationSec = source.durationMs ? source.durationMs / 1000 : undefined;

  return targets.map((target) => {
    const platform = PLATFORMS[target.provider];
    const formatId = target.format || platform?.defaultFormat || Object.keys(platform?.formats ?? {})[0];
    const format = platform?.formats?.[formatId];

    const entry = {
      provider: target.provider,
      format: formatId,
      variant: 'source',
      reasons: [],
      warnings: [],
      errors: [],
    };

    if (!platform || !format) {
      entry.errors.push(`Unknown platform or format: ${target.provider}/${formatId}`);
      return entry;
    }

    if (durationSec !== undefined && Number.isFinite(format.maxDurationSec) && durationSec > format.maxDurationSec) {
      entry.errors.push(
        `Video is ${Math.round(durationSec)}s but ${platform.label} ${format.label} allows ${format.maxDurationSec}s max`,
      );
    }

    const sizeMb = source.size ? source.size / (1024 * 1024) : undefined;
    if (sizeMb !== undefined && Number.isFinite(format.maxSizeMb) && sizeMb > format.maxSizeMb) {
      entry.errors.push(`Video is ${sizeMb.toFixed(1)}MB but ${platform.label} allows ${format.maxSizeMb}MB max`);
    }

    const compatible = isAspectCompatible(sourceAspect, format.aspect);
    const needsReframe = !compatible && format.aspect !== 'any';

    if (needsReframe) {
      if (ffmpegAvailable && autoReframe && platform.preferred) {
        entry.variant = format.aspect.replace(':', 'x');
        entry.reasons.push(
          `Source aspect ${sourceAspect?.toFixed(2)} does not match ${format.aspect}; reframing to ${platform.preferred.width}x${platform.preferred.height}`,
        );
      } else if (!ffmpegAvailable) {
        entry.warnings.push(
          `${platform.label} expects ${format.aspect} but ffmpeg is unavailable — posting the source file as-is`,
        );
      } else {
        entry.warnings.push(`Auto-reframe disabled; ${platform.label} expects ${format.aspect}`);
      }
    }

    if (platform.requiresPublicUrl) entry.warnings.push(`${platform.label} pulls the video by URL — PUBLIC_BASE_URL must be publicly reachable`);

    return entry;
  });
}

/** Turn a plan entry into concrete ffmpeg output settings. */
export function variantSettings(provider, formatId) {
  const platform = PLATFORMS[provider];
  if (!platform?.preferred) return null;
  const { width, height, videoBitrateK, audioBitrateK, fps } = platform.preferred;
  return {
    name: `${provider}-${formatId}`,
    width,
    height,
    videoBitrateK,
    audioBitrateK,
    fps,
    container: platform.container || 'mp4',
  };
}

export function hasBlockingErrors(plan) {
  return plan.some((p) => p.errors.length > 0);
}
