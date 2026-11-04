import { discount } from '../src/pricing';

if (discount(200) !== 20) throw new Error('wrong discount');
