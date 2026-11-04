enum Pricing {
    /// 10% off orders over 100.
    static func discount(for total: Double) -> Double {
        total > 100 ? total * 0.1 : 0
    }
}
