import { discount } from './pricing';

export interface Item {
  name: string;
  price: number;
}

export class Cart {
  items: Item[] = [];

  add(item: Item): void {
    this.items.push(item);
  }

  subtotal(): number {
    return this.items.reduce((sum, i) => sum + i.price, 0);
  }

  total(): number {
    const sub = this.subtotal();
    return sub - discount(sub);
  }
}

// The discount is applied in total().
export function checkout(cart: Cart): string {
  return `Total: ${cart.total()}`;
}
