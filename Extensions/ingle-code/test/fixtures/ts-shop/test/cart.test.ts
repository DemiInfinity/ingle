import { Cart, checkout } from '../src/cart';

const cart = new Cart();
cart.add({ name: 'lamp', price: 200 });
if (checkout(cart) !== 'Total: 180') throw new Error('wrong total');
