/** Weighted scoring for audit groups. info checks are reported but excluded. */

export function scoreGroups(groups) {
  for (const group of groups) {
    let weightSum = 0;
    let valueSum = 0;
    for (const check of group.checks) {
      if (check.status === 'info') continue;
      const value = check.status === 'pass' ? 1 : check.status === 'warn' ? 0.5 : 0;
      weightSum += check.weight;
      valueSum += check.weight * value;
    }
    group.score = weightSum > 0 ? Math.round((valueSum / weightSum) * 100) : 0;
  }
  const total = Math.round(groups.reduce((acc, group) => acc + group.score * group.weight, 0));
  return { total, groups: Object.fromEntries(groups.map((group) => [group.id, group.score])) };
}