import type { PathSegment } from './addon'
import type { TreeNode } from './useTree'

/** Titles a shelf shows on Home. */
export const SHELF_SIZE = 6
/** Titles a folder's page adds each time it's scrolled to the end. */
export const FOLDER_PAGE_SIZE = 24

/** A catalog shown on Home: a row of its first titles, and a way to all of them. */
export interface Shelf {
  node: TreeNode
  label: string
  path: PathSegment[]
}

const segment = (node: TreeNode): PathSegment => ({ key: node.key, label: node.label })

/** Catalog names often start with the addon's, which is already the heading above them. */
export function withoutAddonName(label: string, addonName: string): string {
  return addonName && label !== addonName && label.startsWith(`${addonName} `) ? label.slice(addonName.length + 1) : label
}

/**
 * One shelf per catalog of an addon. A catalog split by genre shows its "All", or
 * its first genre when it has no "All". Catalogs that can't be browsed are left out.
 */
export function shelvesOf(root: TreeNode): Shelf[] {
  const shelves: Shelf[] = []
  for (const child of root.children ?? []) {
    if (child.kind !== 'folder') continue
    const label = withoutAddonName(child.label, root.label)
    if (child.loader?.kind === 'catalog') {
      shelves.push({ node: child, label, path: [segment(child)] })
      continue
    }
    const first = child.children?.find((genre) => genre.kind === 'folder' && genre.loader?.kind === 'catalog')
    if (!first) continue
    shelves.push({
      node: first,
      label: first.label === 'All' ? label : `${label} · ${first.label}`,
      path: [segment(child), segment(first)],
    })
  }
  return shelves
}

/** The titles fetched so far in a catalog. */
export function titlesIn(node: TreeNode): TreeNode[] {
  return (node.children ?? []).filter((child) => child.kind === 'item')
}

/** The "Load more" entry of a catalog with more pages to fetch. */
export function moreIn(node: TreeNode): TreeNode | null {
  return node.children?.find((child) => child.kind === 'more') ?? null
}

/** Where a title in a catalog is, for opening it. */
export function titlePath(catalogPath: PathSegment[], title: TreeNode): PathSegment[] {
  return [...catalogPath, segment(title)]
}

/** The folder at this path, among what's already built below the root. Nothing is fetched. */
export function folderAt(root: TreeNode, path: PathSegment[]): TreeNode | null {
  let node: TreeNode | undefined = root
  for (const step of path) {
    const children: TreeNode[] = node?.children ?? []
    node = children.find((child) => child.key === step.key) ?? children.find((child) => child.label === step.label)
    if (!node) return null
  }
  return node ?? null
}
