import { TradeSide } from "../domain/enums";

// The desk displays USDC prices at cent precision for SOL-sized prices. Arithmetic
// rails can land between cents, so triggers tolerate the displayed cent touching
// the rail instead of forcing the next displayed cent.
export const DISPLAY_PRICE_TRIGGER_EPSILON = 0.005;

export function priceConfirmsTrigger(side: TradeSide, levelPrice: number, currentPrice: number): boolean {
  return side === TradeSide.Buy
    ? currentPrice <= levelPrice + DISPLAY_PRICE_TRIGGER_EPSILON
    : currentPrice >= levelPrice - DISPLAY_PRICE_TRIGGER_EPSILON;
}

export function priceMoveTouchesLevel(levelPrice: number, previousPrice: number, currentPrice: number): boolean {
  const lower = Math.min(previousPrice, currentPrice) - DISPLAY_PRICE_TRIGGER_EPSILON;
  const upper = Math.max(previousPrice, currentPrice) + DISPLAY_PRICE_TRIGGER_EPSILON;
  return levelPrice >= lower && levelPrice <= upper;
}
