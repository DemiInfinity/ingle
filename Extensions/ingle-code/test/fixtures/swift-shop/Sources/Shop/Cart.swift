public struct Item {
    public let name: String
    public let price: Double
}

public final class Cart {
    public private(set) var items: [Item] = []

    public init() {}

    public func add(_ item: Item) {
        items.append(item)
    }

    func subtotal() -> Double {
        items.reduce(0) { $0 + $1.price }
    }

    public func total() -> Double {
        let sub = subtotal()
        return sub - Pricing.discount(for: sub)
    }
}

/// The discount is applied in total().
public func checkout(_ cart: Cart) -> String {
    "Total: \(cart.total())"
}
