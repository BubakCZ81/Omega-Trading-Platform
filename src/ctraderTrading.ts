export interface CTraderVolumeConstraints {
  lotSize: number;
  minVolume: number;
  maxVolume: number;
  volumeStep: number;
}

export interface ValidatedCTraderVolume {
  lots: number;
  volumeInUnits: number;
}

interface DecimalParts {
  coefficient: bigint;
  scale: number;
}

function decimalParts(value: number, label: string): DecimalParts {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`cTrader ${label} must be a positive finite number.`);
  const [mantissa, exponentText] = value.toString().toLowerCase().split('e');
  const exponent = exponentText === undefined ? 0 : Number(exponentText);
  const [whole, fraction = ''] = mantissa.split('.');
  const coefficient = BigInt(`${whole}${fraction}`);
  const rawScale = fraction.length - exponent;
  return rawScale < 0
    ? { coefficient: coefficient * 10n ** BigInt(-rawScale), scale: 0 }
    : { coefficient, scale: rawScale };
}

function atScale(parts: DecimalParts, scale: number): bigint {
  return parts.coefficient * 10n ** BigInt(scale - parts.scale);
}

export function validateCTraderLots(lots: number, constraints: CTraderVolumeConstraints): ValidatedCTraderVolume {
  const lotParts = decimalParts(lots, 'lot quantity');
  const lotSize = decimalParts(constraints.lotSize, 'lot size');
  const minimum = decimalParts(constraints.minVolume, 'minimum volume');
  const maximum = decimalParts(constraints.maxVolume, 'maximum volume');
  const step = decimalParts(constraints.volumeStep, 'volume step');
  const productScale = lotParts.scale + lotSize.scale;
  const scale = Math.max(productScale, minimum.scale, maximum.scale, step.scale);
  const volumeScaled = lotParts.coefficient * lotSize.coefficient * 10n ** BigInt(scale - productScale);
  const minimumScaled = atScale(minimum, scale);
  const maximumScaled = atScale(maximum, scale);
  const stepScaled = atScale(step, scale);

  if (volumeScaled < minimumScaled || volumeScaled > maximumScaled) {
    throw new Error(`The requested cTrader volume is outside the symbol limits (${constraints.minVolume}–${constraints.maxVolume} units).`);
  }
  if ((volumeScaled - minimumScaled) % stepScaled !== 0n) {
    throw new Error(`The requested cTrader volume is not aligned to the symbol step of ${constraints.volumeStep} units; adjust the lot size explicitly.`);
  }

  const unitScale = 10n ** BigInt(scale);
  const maximumSafeScaled = BigInt(Number.MAX_SAFE_INTEGER) * unitScale;
  if (volumeScaled <= 0n || volumeScaled > maximumSafeScaled) {
    throw new Error('The requested cTrader lot quantity does not convert to a positive, safe volume in units.');
  }

  const volumeInUnits = Number(volumeScaled) / Number(unitScale);
  if (!Number.isFinite(volumeInUnits) || volumeInUnits <= 0) {
    throw new Error('The requested cTrader lot quantity does not convert to a positive, safe volume in units.');
  }
  const converted = decimalParts(volumeInUnits, 'converted volume');
  const comparisonScale = Math.max(scale, converted.scale);
  if (atScale(converted, comparisonScale) !== volumeScaled * 10n ** BigInt(comparisonScale - scale)) {
    throw new Error('The requested cTrader lot quantity does not convert to a positive, safe volume in units.');
  }
  return { lots, volumeInUnits };
}
