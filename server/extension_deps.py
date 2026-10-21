"""Resolve extension ``depends`` lists.

An extension may list other extensions it requires:

    "depends": ["camera"]

The dependent extension is not loaded unless every dependency (including
transitive ones) is installed. Dependency environments stay separate; their
site-packages directories are appended to the dependent process so it can
import those libraries without repeating them in its own requirements.txt.
"""

from __future__ import annotations


def depend_entries(manifest):
    """Return ``[{name, url, displayName}, ...]`` for a manifest.

    A dependency may be a name or ``{"name": "camera", "url": "https://..."}``.
    ``url`` is the GitHub repository (or a zip) used when that extension
    is not installed yet.
    """
    if not isinstance(manifest, dict):
        return []
    raw = manifest.get('depends')
    if raw is None:
        raw = manifest.get('dependencies')
    if isinstance(raw, dict):
        raw = raw.get('extensions') or []
    if isinstance(raw, str):
        raw = [raw]
    if not isinstance(raw, list):
        return []
    entries = []
    seen = set()
    for item in raw:
        name = ''
        url = ''
        display = ''
        if isinstance(item, str):
            name = item.strip()
        elif isinstance(item, dict):
            name = str(item.get('name') or item.get('extension') or '').strip()
            url = str(item.get('url') or item.get('source') or '').strip()
            display = str(item.get('displayName') or item.get('display_name') or '').strip()
        if not name or name in seen:
            continue
        seen.add(name)
        entries.append({
            'name': name,
            'url': url,
            'displayName': display or name,
        })
    return entries


def normalize_depends(manifest):
    """Return a list of extension names this manifest depends on."""
    return [entry['name'] for entry in depend_entries(manifest)]


def _missing_transitive(name, manifests, stack, seen_missing):
    """Names that are not installed anywhere in this extension's dependency tree."""
    if name in seen_missing:
        return []
    manifest = manifests.get(name)
    if manifest is None:
        return [name]
    missing = []
    stack.append(name)
    for dep in normalize_depends(manifest):
        if dep in stack:
            continue
        missing.extend(_missing_transitive(dep, manifests, stack, seen_missing))
    stack.pop()
    return missing


def resolve_extensions(manifests):
    """Topologically order extensions and report ones that cannot load.

    Args:
        manifests: ``{name: manifest}`` for installed extensions.

    Returns:
        ``(order, skipped)`` where ``order`` is names that can load
        (dependencies first) and ``skipped`` maps a name to a reason string.
    """
    names = list(manifests.keys())
    skipped = {}

    for name in names:
        manifest = manifests[name]
        missing = []
        stack = []
        for dep in normalize_depends(manifest):
            missing.extend(_missing_transitive(dep, manifests, stack, set()))
        # unique, stable
        uniq = []
        seen = set()
        for dep in missing:
            if dep not in seen:
                seen.add(dep)
                uniq.append(dep)
        if uniq:
            skipped[name] = 'requires extension(s): ' + ', '.join(uniq)

    # Cycle detection among extensions that are otherwise present.
    graph = {}
    for name in names:
        if name in skipped:
            continue
        graph[name] = [
            dep for dep in normalize_depends(manifests[name])
            if dep in manifests and dep not in skipped
        ]

    indegree = {name: 0 for name in graph}
    for name, deps in graph.items():
        for dep in deps:
            if dep in indegree:
                indegree[name] = indegree.get(name, 0)  # keep
    # recompute indegree as number of deps that must come first
    indegree = {name: 0 for name in graph}
    for name, deps in graph.items():
        indegree[name] = len([d for d in deps if d in graph])

    ready = sorted([name for name, deg in indegree.items() if deg == 0])
    order = []
    while ready:
        name = ready.pop(0)
        order.append(name)
        for other, deps in graph.items():
            if name in deps and other not in order and other not in ready:
                indegree[other] -= 1
                if indegree[other] == 0:
                    ready.append(other)
                    ready.sort()

    for name in graph:
        if name not in order:
            skipped[name] = 'dependency cycle involving: ' + ', '.join(
                normalize_depends(manifests[name])
            )
    return order, skipped


def dependency_chain(name, manifests):
    """Direct then transitive dependency names, direct dependencies first."""
    if name not in manifests:
        return []
    ordered = []
    seen = set()

    def walk(current):
        for dep in normalize_depends(manifests.get(current) or {}):
            if dep in seen or dep not in manifests:
                continue
            seen.add(dep)
            ordered.append(dep)
            walk(dep)

    walk(name)
    return ordered
