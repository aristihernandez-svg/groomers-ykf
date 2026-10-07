// Coming or going? ADS-B carries no destination, so a departure that turns back over the
// field can point at the airport exactly like an arrival. This compares each plane with
// where it was on the job's previous run (fleetPositions/live, ~2 min ago) and with the
// climb rate it reports:
//   leaving  — just took off, climbing, or further from the airport than last time
//   arriving — closer than last time (and not climbing), or first seen while descending
//   unsure   — nothing to compare with yet; the next run decides
// Kept on its own so it can be tested without Firebase.

const CLIMB_FPM    = 500;  // climbing faster than this = a departure climbing out
const CLIMB_FT     = 300;  // or this much higher than on the last run
const DESCEND_FPM  = -300; // first sighting while descending this fast counts as an arrival
const AWAY_SLACK_NM = 0.3; // the two feeds can disagree slightly on the same plane

function haversineNm(lat1, lon1, lat2, lon2) {
  const R = 3440.065;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180)
    * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ac / prev: { lat, lon, altFt, vRateFpm, onGround, speedKts }; prev may be null.
function comingOrGoing(ac, prev, lat, lon) {
  const dist = haversineNm(ac.lat, ac.lon, lat, lon);
  const vr = typeof ac.vRateFpm === 'number' ? ac.vRateFpm : null;
  const hasPrev = prev && typeof prev.lat === 'number' && typeof prev.lon === 'number';
  if (hasPrev && (prev.onGround || (prev.speedKts != null && prev.speedKts < 50)))
    return { verdict: 'leaving', why: 'was on the ground last run — just took off' };
  if (vr != null && vr > CLIMB_FPM)
    return { verdict: 'leaving', why: `climbing ${vr} ft/min` };
  // (only when the plane doesn't report its climb rate — a level-off right after a short climb is fine)
  if (vr == null && hasPrev && typeof ac.altFt === 'number' && typeof prev.altFt === 'number' && ac.altFt - prev.altFt > CLIMB_FT)
    return { verdict: 'leaving', why: `climbed ${ac.altFt - prev.altFt} ft since last run` };
  if (hasPrev) {
    const before = haversineNm(prev.lat, prev.lon, lat, lon);
    if (dist > before + AWAY_SLACK_NM) return { verdict: 'leaving', why: `moving away (${before.toFixed(1)} → ${dist.toFixed(1)} nm)` };
    if (dist < before) return { verdict: 'arriving', why: `getting closer (${before.toFixed(1)} → ${dist.toFixed(1)} nm)` };
    return { verdict: 'unsure', why: 'about the same distance as last run' };
  }
  if (vr != null && vr < DESCEND_FPM) return { verdict: 'arriving', why: `first seen descending ${vr} ft/min` };
  return { verdict: 'unsure', why: 'first sighting — checking again next run' };
}

module.exports = { comingOrGoing, haversineNm };
