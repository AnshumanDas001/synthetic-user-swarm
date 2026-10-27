// The seeded-defect benchmark: a demo shop with known usability bugs. Each defect can be switched off
// ("deploy the fix") so a rerun shows the run diff marking it fixed. Recall and precision are measured
// against this list (benchmark/defects.json mirrors it for the scorer).
export interface Defect {
  id: string;
  title: string;
  page: string;          // page path where it shows
  keywords: string[];    // words an issue about it would mention (for the benchmark matcher)
  must: string[];        // an issue must mention at least one of these to count as this defect
  symptom: string;       // what a user experiences, for the judge-model matcher
}

export const DEFECTS: Defect[] = [
  { id: "D01", symptom: "On phones a large cookie banner fixed to the bottom covers content, including the bag page's sticky Checkout bar, until it is accepted.", must: ["cookie", "banner"], title: "Checkout button hidden under the cookie banner on mobile", page: "/bag", keywords: ["checkout", "cookie", "banner", "covered", "hidden"] },
  { id: "D02", symptom: "Pressing Add to bag on a product page shows no confirmation and the header bag count does not change (the item is added silently).", must: ["add to bag", "add to cart"], title: "Add to bag gives no feedback", page: "/products/:id", keywords: ["add to bag", "feedback", "nothing happened", "does nothing", "bag count", "no confirmation"] },
  { id: "D03", symptom: "The magnifier search button in the header is an icon with no accessible name, so screen readers announce just 'button'.", must: ["accessible name", "label", "unlabeled", "icon"], title: "Search icon button has no accessible name", page: "/", keywords: ["search", "icon", "accessible name", "label", "unlabeled"] },
  { id: "D04", symptom: "On checkout, Place order does nothing unless the phone is typed exactly as +1 (555) 123-4567; no error message is shown.", must: ["phone"], title: "Phone field fails validation silently", page: "/checkout", keywords: ["phone", "validation", "silent", "nothing happens", "place order", "error"] },
  { id: "D05", symptom: "On the bag page 'Continue shopping' is the big primary button while 'Checkout' is a small faint text link.", must: ["continue shopping", "checkout link", "checkout button"], title: "Continue shopping styled as the primary action instead of Checkout", page: "/bag", keywords: ["continue shopping", "checkout", "primary", "hierarchy", "faint"] },
  { id: "D06", symptom: "On product pages and the bag page, delivery information and the checkout links are very light grey text that is hard to read (low contrast).", must: ["contrast", "faint", "hard to read", "grey", "gray"], title: "Delivery and checkout text is too low-contrast to read", page: "/bag", keywords: ["contrast", "faint", "grey", "gray", "hard to read", "color-contrast"] },
  { id: "D07", symptom: "Jargon: product pages show 'SKU' and 'RRP', the bag shows 'Cart subtotal excl. VAT'.", must: ["sku", "vat", "subtotal", "jargon", "rrp"], title: "Jargon: 'SKU' and 'Cart subtotal excl. VAT'", page: "/bag", keywords: ["sku", "subtotal", "vat", "jargon", "excl"] },
  { id: "D08", symptom: "Searching for 'gift' (or 'present', 'teen') returns no results; search only matches exact product-name words.", must: ["search"], title: "Search for 'gift' returns zero results", page: "/search", keywords: ["search", "no results", "zero results", "gift"] },
  { id: "D09", symptom: "A newsletter pop-up opens on the home page; keyboard focus is trapped between its email box and Subscribe, Escape does nothing, and the x is not a real button.", must: ["newsletter", "pop-up", "popup", "modal", "focus"], title: "Newsletter pop-up traps keyboard focus and cannot be closed from the keyboard", page: "/", keywords: ["newsletter", "pop-up", "popup", "modal", "trap", "close", "keyboard", "escape"] },
  { id: "D10", symptom: "Checkout opens on 'Create an account to continue' (which rejects passwords); the guest option is a tiny faint link at the bottom.", must: ["account", "guest"], title: "Checkout forces account creation; guest option hidden", page: "/checkout", keywords: ["account", "guest", "sign up", "register", "forced"] },
  { id: "D11", symptom: "On the product list a promo banner appears about 1.2 s after load and pushes the product grid down.", must: ["shift", "moved", "jump", "layout"], title: "Promo banner loads late and shifts the product list", page: "/products", keywords: ["layout shift", "banner", "moved", "shift", "jump"] },
  { id: "D12", symptom: "The coupon field's Apply button on the bag page does nothing at all.", must: ["coupon", "promo", "apply"], title: "Apply coupon button does nothing", page: "/bag", keywords: ["coupon", "apply", "promo code", "does nothing", "dead"] },
  { id: "D13", symptom: "Checkout address, city and ZIP fields have placeholder text but no visible labels.", must: ["placeholder", "label"], title: "Address fields use placeholders as their only label", page: "/checkout", keywords: ["placeholder", "label", "address", "field"] },
  { id: "D14", symptom: "Once Place order is accepted, the order takes about 3.5 s with no spinner and the button stays enabled.", must: ["slow", "spinner", "progress", "loading", "takes"], title: "Place order is slow with no progress indicator", page: "/checkout", keywords: ["place order", "slow", "spinner", "loading", "progress", "twice"] },
];

export class DefectSwitchboard {
  private on: Set<string>;

  constructor(spec = process.env.DEFECTS ?? "all") {
    this.on = new Set(spec === "all" ? DEFECTS.map((d) => d.id) : spec === "none" ? [] : spec.split(",").map((s) => s.trim().toUpperCase()));
  }

  has(id: string): boolean {
    return this.on.has(id);
  }

  set(id: string, enabled: boolean): void {
    if (enabled) this.on.add(id);
    else this.on.delete(id);
  }

  list() {
    return DEFECTS.map((d) => ({ ...d, enabled: this.on.has(d.id) }));
  }
}
