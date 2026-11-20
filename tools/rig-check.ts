/**
 * Rig diagnostic: verifies the articulated skeleton stays anatomically sane
 * across a long simulated run (bone lengths, joint placement, foot contact).
 */
import { World } from '../src/game/world';
import { SKELETON } from '../src/game/config';
import { createInputState } from '../src/core/types';

const world = new World({ difficulty: 'medium', seed: 20260101 });
world.start();

let violations = 0;
let footContacts = 0;
let samples = 0;
let maxFootGap = 0;

for (let i = 0; i < 4000; i++) {
  world.currentInput = { ...createInputState(), moveX: 1 };
  world.update(1 / 120);
  const rig = world.player.rig;

  for (const leg of [rig.leftLeg, rig.rightLeg]) {
    if (!leg) continue;
    const l1 = Math.hypot(leg.joint.x - leg.root.x, leg.joint.y - leg.root.y);
    const l2 = Math.hypot(leg.end.x - leg.joint.x, leg.end.y - leg.joint.y);
    if (Math.abs(l1 - SKELETON.thighLength) > 0.5) {
      violations++;
    }
    if (Math.abs(l2 - SKELETON.shinLength) > 0.5) {
      violations++;
    }
  }

  // Foot contact: when grounded, a planted foot must be on the surface.
  if (world.player.grounded && world.player.state === 'run') {
    for (const foot of [rig.leftFoot, rig.rightFoot]) {
      if (!foot.grounded) continue;
      footContacts++;
      const hit = world.terrain.raycastDown(foot.toe.x, foot.toe.y - 6, 40);
      const gap = hit.hit ? Math.abs(hit.y - foot.toe.y) : 999;
      maxFootGap = Math.max(maxFootGap, gap);
      if (gap > 6) violations++;
    }
  }
  samples++;
}

console.log('samples          ', samples);
console.log('bone violations  ', violations);
console.log('foot contacts    ', footContacts);
console.log('max foot gap     ', maxFootGap.toFixed(2), 'px');
console.log('final state      ', world.player.state);
console.log('distance         ', world.stats.distance.toFixed(1), 'm');
console.log('flow             ', world.flow.value.toFixed(1), 'tier', world.flow.tier);
console.log('clean moves      ', world.flow.cleanMoves);
