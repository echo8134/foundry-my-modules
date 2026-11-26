const WIDE_RING = 7;
const GAP = 50;
const WIDE_GAP = 64;

// Degrees clockwise from the top. Two slots sit left and right of the top so slot 1 stays above the centre line.
export function slotAngles(count) {
  if (count === 1) return [0];
  if (count === 2) return [-40, 40];
  return Array.from({ length: count }, (_, i) => (i * 360) / count);
}

export function ringRadius(diameter, count, distance) {
  const gap = count >= WIDE_RING ? WIDE_GAP : GAP;
  return diameter / 2 + (gap * distance) / 100;
}

export function slotOffsets(count, radius) {
  return slotAngles(count).map((degrees) => {
    const radians = (degrees * Math.PI) / 180;
    return { dx: Math.round(radius * Math.sin(radians)), dy: Math.round(-radius * Math.cos(radians)) };
  });
}
