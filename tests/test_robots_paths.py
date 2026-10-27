from swarm.runtime.perception import state_hash
from swarm.runtime.robots import parse_robots, robots_blocks
from swarm.util import page_path

TOOLSHOP = """# Practice Software Testing - Toolshop
User-agent: *
Allow: /
Disallow: /account
Disallow: /admin
Disallow: /auth
Disallow: /checkout

Sitemap: https://practicesoftwaretesting.com/sitemap.xml"""
RULES = parse_robots(TOOLSHOP, "practicesoftwaretesting.com")


def test_reads_disallowed_paths():
    assert RULES["disallow"] == ["/account", "/admin", "/auth", "/checkout"]


def test_blocks_same_host_only():
    assert robots_blocks(RULES, "https://practicesoftwaretesting.com/checkout")
    assert robots_blocks(RULES, "https://practicesoftwaretesting.com/auth/login")
    assert not robots_blocks(RULES, "https://practicesoftwaretesting.com/product/01M5YKQMJ2FCGMPD7B57TC2VF4")
    assert not robots_blocks(RULES, "https://api.practicesoftwaretesting.com/checkout")


def test_other_agents_and_longer_allow():
    assert parse_robots("User-agent: Googlebot\nDisallow: /\n\nUser-agent: *\nDisallow: /private\nAllow: /private/help", "x.com")["disallow"] == []
    assert robots_blocks(parse_robots("User-agent: *\nDisallow: /private", "x.com"), "https://x.com/private/a")


def test_page_paths_collapse_ids():
    assert page_path("https://practicesoftwaretesting.com/product/01M5YKQMJ2FCGMPD7B57TC2VF4") == "/product/:id"
    assert page_path("https://x.com/orders/3f2a9c1e-5b7d-4e8a-9c21-7d4e5f6a8b90/items/42") == "/orders/:id/items/:id"
    assert page_path("https://x.com/category/hand-tools") == "/category/hand-tools"


def test_scroll_bands_in_state_hash():
    a = state_hash("https://x.com/", [], "t", {"y": 0, "vh": 800})
    assert state_hash("https://x.com/", [], "t", {"y": 900, "vh": 800}) != a
    assert state_hash("https://x.com/", [], "t", {"y": 10, "vh": 800}) == a
