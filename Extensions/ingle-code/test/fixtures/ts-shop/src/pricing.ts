/** 10% off orders over 100. */
export function discount(total: number): number {
  return total > 100 ? total * 0.1 : 0;
}
