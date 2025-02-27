/**
 * Copyright 2023-present DreamNum Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import type { IAccessor } from '@wendellhu/redi';
import type { ITextRange, ITextRangeParam } from '../../../../sheets/typedef';
import type { CustomRangeType, IDocumentBody } from '../../../../types/interfaces';
import type { DocumentDataModel } from '../../document-data-model';
import type { IDeleteAction, IRetainAction } from '../action-types';
import { type Nullable, UpdateDocsAttributeType } from '../../../../shared';
import { DataStreamTreeTokenType } from '../../types';
import { TextXActionType } from '../action-types';
import { TextX } from '../text-x';
import { excludePointsFromRange, isIntersecting, shouldDeleteCustomRange } from './custom-range';
import { getDeleteSelection, getSelectionForAddCustomRange } from './selection';

export interface IDeleteCustomRangeParam {
    rangeId: string;
    segmentId?: string;
    documentDataModel: DocumentDataModel;
    insert?: Nullable<IDocumentBody>;
    textRange?: { index: number };
}

export function deleteCustomRangeTextX(accessor: IAccessor, params: IDeleteCustomRangeParam) {
    const { rangeId, segmentId, documentDataModel, insert, textRange } = params;

    const range = documentDataModel.getSelfOrHeaderFooterModel(segmentId).getBody()?.customRanges?.find((r) => r.rangeId === rangeId);
    if (!range) {
        return false;
    }

    const { startIndex, endIndex } = range;
    const textX = new TextX();

    const len = endIndex - startIndex + 1;

    if (startIndex > 0) {
        textX.push({
            t: TextXActionType.RETAIN,
            len: startIndex,
        });
    }

    textX.push({
        t: TextXActionType.DELETE,
        len: 1,
    });
    if (textRange) {
        if (textRange.index > startIndex) {
            textRange.index--;
        }
    }

    if (len - 2 > 0) {
        textX.push({
            t: TextXActionType.RETAIN,
            len: len - 2,
        });
    }

    textX.push({
        t: TextXActionType.DELETE,
        len: 1,
    });

    if (textRange) {
        if (textRange.index > endIndex) {
            textRange.index--;
        }
    }

    if (insert) {
        textX.push({
            body: insert,
            t: TextXActionType.INSERT,
            len: insert.dataStream.length,
        });

        if (textRange) {
            if (textRange.index > endIndex) {
                textRange.index += insert.dataStream.length;
            }
        }
    }
    return textX;
}

export interface IAddCustomRangeTextXParam {
    range: ITextRange;
    segmentId?: string;
    rangeId: string;
    rangeType: CustomRangeType;
    properties?: Record<string, any>;
    wholeEntity?: boolean;
    body: IDocumentBody;
}

// eslint-disable-next-line max-lines-per-function
export function addCustomRangeTextX(param: IAddCustomRangeTextXParam) {
    const { range, rangeId, rangeType, segmentId, wholeEntity, properties, body } = param;
    const actualRange = getSelectionForAddCustomRange(range, body);
    if (!actualRange) {
        return false;
    }

    if (!body) {
        return false;
    }

    const { startOffset, endOffset } = actualRange;

    const customRanges = body.customRanges ?? [];
    let cursor = 0;
    const textX = new TextX();

    // eslint-disable-next-line max-lines-per-function
    const addCustomRange = (startIndex: number, endIndex: number, index: number) => {
        const relativeCustomRanges = [];
        for (let i = 0, len = customRanges.length; i < len; i++) {
            const customRange = customRanges[i];
            // intersect
            if (customRange.rangeType === rangeType && Math.max(customRange.startIndex, startIndex) <= Math.min(customRange.endIndex, endIndex)) {
                relativeCustomRanges.push({ ...customRange });
            }

            // optimize
            if (customRange.startIndex > endIndex) {
                break;
            }
        }
        const deletes = relativeCustomRanges.map((i) => [i.startIndex, i.endIndex]).flat().sort((pre, aft) => pre - aft);

        const range = deletes.length
            ? {
                startOffset: Math.min(deletes[0], startIndex),
                endOffset: Math.max(deletes[deletes.length - 1] + 1, endIndex + 1),
            }
            : {
                startOffset: startIndex,
                endOffset: endIndex + 1,
            };

        if (range.startOffset !== cursor) {
            textX.push({
                t: TextXActionType.RETAIN,
                len: range.startOffset - cursor,
            });
            cursor = range.startOffset;
        }
        textX.push({
            t: TextXActionType.INSERT,
            body: {
                dataStream: DataStreamTreeTokenType.CUSTOM_RANGE_START,
            },
            len: 1,
        });

        deletes.forEach((index) => {
            if (index !== cursor) {
                textX.push({
                    t: TextXActionType.RETAIN,
                    len: index - cursor,
                });
                cursor = index;
            }
            textX.push({
                t: TextXActionType.DELETE,
                len: 1,
            });
            cursor++;
        });

        if (cursor !== range.endOffset) {
            textX.push({
                t: TextXActionType.RETAIN,
                len: range.endOffset - cursor,
            });
            cursor = range.endOffset;
        }

        textX.push({
            t: TextXActionType.INSERT,
            body: {
                dataStream: DataStreamTreeTokenType.CUSTOM_RANGE_END,
                customRanges: [
                    {
                        rangeId: index ? `${rangeId}-${index}` : rangeId,
                        rangeType,
                        startIndex: -(range.endOffset - range.startOffset - deletes.length + 1),
                        endIndex: 0,
                        wholeEntity,
                        properties: {
                            ...properties,
                        },
                    },
                ],
            },
            len: 1,
        });
    };
    const relativeParagraphs = (body.paragraphs ?? []).filter((p) => p.startIndex < endOffset && p.startIndex > startOffset);
    const newRanges = excludePointsFromRange([startOffset, endOffset - 1], relativeParagraphs.map((p) => p.startIndex));
    newRanges.forEach(([start, end], i) => addCustomRange(start, end, i));

    return textX;
}

// If the selection contains line breaks,
// paragraph information needs to be preserved when performing the CUT operation
// eslint-disable-next-line max-lines-per-function
export function getRetainAndDeleteAndExcludeLineBreak(
    selection: ITextRange,
    body: IDocumentBody,
    segmentId: string = '',
    memoryCursor: number = 0,
    preserveLineBreak: boolean = true
): Array<IRetainAction | IDeleteAction> {
    const { startOffset, endOffset } = getDeleteSelection(selection, body);
    const dos: Array<IRetainAction | IDeleteAction> = [];
    const { paragraphs = [], dataStream } = body;

    const textStart = startOffset - memoryCursor;
    const textEnd = endOffset - memoryCursor;

    const paragraphInRange = paragraphs?.find(
        (p) => p.startIndex - memoryCursor >= textStart && p.startIndex - memoryCursor < textEnd
    );

    const relativeCustomRanges = body.customRanges?.filter((customRange) => isIntersecting(customRange.startIndex, customRange.endIndex, startOffset, endOffset - 1));
    const toDeleteRanges = new Set(relativeCustomRanges?.filter((customRange) => shouldDeleteCustomRange(startOffset, endOffset - startOffset, customRange, dataStream)));
    const retainPoints = new Set<number>();
    relativeCustomRanges?.forEach((range) => {
        if (toDeleteRanges.has(range)) {
            return;
        }

        if (range.startIndex - memoryCursor >= textStart &&
            range.startIndex - memoryCursor <= textEnd &&
            range.endIndex - memoryCursor > textEnd) {
            retainPoints.add(range.startIndex);
        }
        if (range.endIndex - memoryCursor >= textStart &&
            range.endIndex - memoryCursor <= textEnd &&
            range.startIndex < textStart) {
            retainPoints.add(range.endIndex);
        }
    });

    if (textStart > 0) {
        dos.push({
            t: TextXActionType.RETAIN,
            len: textStart,
        });
    }

    if (preserveLineBreak) {
        if (paragraphInRange && paragraphInRange.startIndex - memoryCursor > textStart) {
            const paragraphIndex = paragraphInRange.startIndex - memoryCursor;
            retainPoints.add(paragraphIndex);
        }
    }

    const sortedRetains = [...retainPoints].sort((pre, aft) => pre - aft);

    let cursor = textStart;
    sortedRetains.forEach((pos) => {
        const len = pos - cursor;
        if (len > 0) {
            dos.push({
                t: TextXActionType.DELETE,
                len,
            });
        }
        dos.push({
            t: TextXActionType.RETAIN,
            len: 1,
        });
        cursor = pos + 1;
    });

    if (cursor < textEnd) {
        dos.push({
            t: TextXActionType.DELETE,
            len: textEnd - cursor,
        });
        cursor = textEnd;
    }

    if (!preserveLineBreak) {
        const nextParagraph = paragraphs.find((p) => p.startIndex - memoryCursor >= textEnd);
        if (nextParagraph) {
            if (nextParagraph.startIndex > cursor) {
                dos.push({
                    t: TextXActionType.RETAIN,
                    len: nextParagraph.startIndex - cursor,
                });
                cursor = nextParagraph.startIndex;
            }

            dos.push({
                t: TextXActionType.RETAIN,
                len: 1,
                body: {
                    dataStream: '',
                    paragraphs: [
                        {
                            ...nextParagraph,
                            startIndex: 0,
                            bullet: paragraphInRange?.bullet,
                        },
                    ],
                },
                coverType: UpdateDocsAttributeType.REPLACE,
            });
        }
    }

    return dos;
}

export interface IReplaceSelectionTextXParams {
    /**
     * range to be replaced.
     */
    selection: ITextRangeParam;

    /** Body to be inserted at the given position. */
    body: IDocumentBody; // Do not contain `\r\n` at the end.
    /**
     * origin document data model.
     */
    doc: DocumentDataModel;
}

export const replaceSelectionTextX = (params: IReplaceSelectionTextXParams) => {
    const { selection, body: insertBody, doc } = params;
    const segmentId = selection.segmentId;
    const body = doc.getSelfOrHeaderFooterModel(segmentId)?.getBody();
    if (!body) return false;

    const textX = new TextX();
    const deleteActions = getRetainAndDeleteAndExcludeLineBreak(selection, body, segmentId);
    // delete
    if (deleteActions.length) {
        textX.push(...deleteActions);
    }
    // insert
    textX.push({
        t: TextXActionType.INSERT,
        body: insertBody,
        len: insertBody.dataStream.length,
    });

    return textX;
};
