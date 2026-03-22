"""services 共有ユーティリティ"""
from __future__ import annotations


def sort_sections_hierarchically(sections: list) -> list:
    """セクションリストを階層順（深さ優先・兄弟はorder昇順）に並べ替える。

    section.order は「同じ親内での並び順」であり、フラットな昇順ソートでは
    異なる親を持つセクションが誤った順序になる。この関数は親子関係を考慮して
    正しい表示順に並べ直す。
    """
    by_parent: dict = {}
    for s in sections:
        pid = s.parent_id
        by_parent.setdefault(pid, []).append(s)
    for children in by_parent.values():
        children.sort(key=lambda s: s.order)

    result = []

    def collect(parent_id):
        for s in by_parent.get(parent_id, []):
            result.append(s)
            collect(s.id)

    collect(None)
    return result
