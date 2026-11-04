@testable import Shop

func cartTotalIncludesDiscount() -> Bool {
    let cart = Cart()
    cart.add(Item(name: "lamp", price: 200))
    return cart.total() == 180
}
