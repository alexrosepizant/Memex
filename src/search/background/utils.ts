import type Storex from '@worldbrain/storex'
import type {
    UnifiedBlankSearchResult,
    UnifiedTermsSearchParams,
} from './types'
import type { SearchParams as OldSearchParams } from '../types'
import type {
    Page,
    Visit,
    Bookmark,
    Annotation,
} from '@worldbrain/memex-common/lib/types/core-data-types/client'
import type { DexieStorageBackend } from '@worldbrain/storex-backend-dexie'
import type Dexie from 'dexie'

export const reshapeParamsForOldSearch = (params): OldSearchParams => ({
    lists: params.collections,
    bookmarks: params.bookmarksOnly,
    domains: params.domainsInc,
    domainsExclude: params.domainsExc,
    tags: params.tagsInc,
    tagsExc: params.tagsExc,
    terms: params.termsInc,
    termsExclude: params.termsExc,
    limit: params.limit,
    skip: params.skip,
    startDate: Number(params.startDate) || undefined,
    endDate: Number(params.endDate) || undefined,
})

export const reshapeAnnotForDisplay = ({
    url,
    pageUrl,
    body,
    comment,
    createdWhen,
    tags,
    hasBookmark,
}) => ({
    url,
    pageUrl,
    body,
    comment,
    createdWhen,
    tags: tags.map((tag) => tag.name),
    hasBookmark,
})

export const reshapePageForDisplay = (page) => ({
    url: page.url,
    fullUrl: page.fullUrl,
    title: page.fullTitle,
    text: page.text,
    hasBookmark: page.hasBookmark,
    screenshot: page.screenshot,
    favIcon: page.favIcon,
    annotations: page.annotations ?? [],
    tags: page.tags,
    lists: page.lists,
    displayTime: page.displayTime,
    annotsCount: page.annotsCount,
})

export const sortUnifiedBlankSearchResult = (
    resultDataByPage: UnifiedBlankSearchResult['resultDataByPage'],
) =>
    [...resultDataByPage].sort(
        ([, a], [, b]) =>
            Math.max(
                b.latestPageTimestamp,
                b.annotations[0]?.lastEdited.valueOf() ?? 0,
            ) -
            Math.max(
                a.latestPageTimestamp,
                a.annotations[0]?.lastEdited.valueOf() ?? 0,
            ),
    )

/** Given separate result sets of the same type, gets the intersection of them / ANDs them together by ID */
const intersectResults = (results: string[][]): string[] =>
    !results.length
        ? []
        : results.reduce((a, b) => {
              const ids = new Set(b)
              return a.filter((id) => ids.has(id))
          })

export const queryAnnotationsByTerms = (
    storageManager: Storex,
): UnifiedTermsSearchParams['queryAnnotations'] => async (
    terms,
    phrases = [],
) => {
    const dexie = (storageManager.backend as DexieStorageBackend).dexieInstance
    const table = dexie.table<Annotation, string>('annotations')
    const resultsPerTerm = await Promise.all([
        ...terms.map((term) =>
            table
                .where('_body_terms')
                .equals(term)
                .or('_comment_terms')
                .equals(term)
                .primaryKeys(),
        ),
        ...phrases.map((phrase) =>
            table
                .filter((a) => {
                    const inComment = a.comment
                        ?.toLocaleLowerCase()
                        .includes(phrase)
                    const inHighlight =
                        'body' in a
                            ? a.body?.toLocaleLowerCase().includes(phrase)
                            : false
                    return inComment || inHighlight
                })
                .primaryKeys(),
        ),
    ])
    const matchingIds = intersectResults(resultsPerTerm)
    return table.bulkGet(matchingIds)
}

export const queryPagesByTerms = (
    storageManager: Storex,
    opts?: {
        startsWithMatching?: boolean
    },
): UnifiedTermsSearchParams['queryPages'] => async (terms, phrases = []) => {
    const dexie = (storageManager.backend as DexieStorageBackend).dexieInstance
    const table = dexie.table<Page, string>('pages')
    const resultsPerTerm = await Promise.all([
        ...terms.map((term) => {
            const coll = opts?.startsWithMatching
                ? table
                      .where('terms')
                      .startsWith(term)
                      .or('urlTerms')
                      .startsWith(term)
                      .or('titleTerms')
                      .startsWith(term)
                : table
                      .where('terms')
                      .equals(term)
                      .or('urlTerms')
                      .equals(term)
                      .or('titleTerms')
                      .equals(term)

            return coll.distinct().primaryKeys()
        }),
        ...phrases.map((phrase) =>
            table
                .filter((page) =>
                    page.text?.toLocaleLowerCase().includes(phrase),
                )
                .primaryKeys(),
        ),
    ])
    const matchingIds = intersectResults(resultsPerTerm)

    // Get latest visit/bm for each page
    const latestTimestampByPageUrl = new Map<string, number>()
    const trackLatestTimestamp = ({ url, time }: Visit | Bookmark) =>
        latestTimestampByPageUrl.set(
            url,
            Math.max(time, latestTimestampByPageUrl.get(url) ?? 0),
        )
    const queryTimestamps = <T>(table: Dexie.Table<T>): Promise<T[]> =>
        table.where('url').anyOf(matchingIds).reverse().sortBy('time')

    const [visits, bookmarks] = await Promise.all([
        queryTimestamps(dexie.table<Visit>('visits')),
        queryTimestamps(dexie.table<Bookmark>('bookmarks')),
    ])

    visits.forEach(trackLatestTimestamp)
    bookmarks.forEach(trackLatestTimestamp)

    return matchingIds.map((id) => ({
        id,
        latestTimestamp: latestTimestampByPageUrl.get(id) ?? 0,
    }))
}

export const splitQueryIntoTerms = (
    query: string,
): { terms: string[]; phrases: string[] } => {
    const discreteTerms = new Set<string>()
    const phrases = new Set<string>()

    // First split by double quotes, then by spaces on non-double quoted phrases
    const terms = query.toLocaleLowerCase().split('"').filter(Boolean)
    for (const term of terms) {
        const wasNotDoubleQuoted =
            term.trim().length !== term.length || term === query

        if (wasNotDoubleQuoted) {
            const subTerms = term.split(/\s+/).filter(Boolean)
            subTerms.forEach((subTerm) => discreteTerms.add(subTerm))
        } else {
            phrases.add(term)
        }
    }
    return { terms: [...discreteTerms], phrases: [...phrases] }
}
