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

import type { DocumentDataModel, ICommand, ICommandInfo } from '@univerjs/core';
import type { IRichTextEditingMutationParams } from '@univerjs/docs';
import { BuildTextUtils, CommandType, ICommandService, IUniverInstanceService, JSONX, TextX, TextXActionType, UniverInstanceType } from '@univerjs/core';
import { RichTextEditingMutation } from '@univerjs/docs';
import { IRenderManagerService, type ITextRangeWithStyle } from '@univerjs/engine-render';
import { getTextRunAtPosition } from '../../basics/paragraph';
import { DocIMEInputManagerService } from '../../services/doc-ime-input-manager.service';
import { DocMenuStyleService } from '../../services/doc-menu-style.service';
import { getRichTextEditPath } from '../util';

export interface IIMEInputCommandParams {
    unitId: string;
    newText: string;
    oldTextLen: number;
    isCompositionStart: boolean;
    isCompositionEnd: boolean;
}

export const IMEInputCommand: ICommand<IIMEInputCommandParams> = {
    id: 'doc.command.ime-input',

    type: CommandType.COMMAND,

    // eslint-disable-next-line max-lines-per-function
    handler: async (accessor, params: IIMEInputCommandParams) => {
        const { unitId, newText, oldTextLen, isCompositionEnd, isCompositionStart } = params;
        const commandService = accessor.get(ICommandService);
        const renderManagerService = accessor.get(IRenderManagerService);
        const univerInstanceService = accessor.get(IUniverInstanceService);
        const docMenuStyleService = accessor.get(DocMenuStyleService);

        const imeInputManagerService = renderManagerService.getRenderById(unitId)?.with(DocIMEInputManagerService);
        const docDataModel = univerInstanceService.getUnit<DocumentDataModel>(unitId, UniverInstanceType.UNIVER_DOC);

        if (docDataModel == null || imeInputManagerService == null) {
            return false;
        }

        const previousActiveRange = imeInputManagerService.getActiveRange();
        if (!previousActiveRange) {
            return false;
        }

        const { style, segmentId } = previousActiveRange;
        const body = docDataModel.getSelfOrHeaderFooterModel(segmentId).getBody();

        if (body == null) {
            return false;
        }

        const insertRange = BuildTextUtils.selection.getInsertSelection(previousActiveRange, body);
        Object.assign(previousActiveRange, insertRange);
        const { startOffset } = previousActiveRange;

        const len = newText.length;

        const textRanges: ITextRangeWithStyle[] = [
            {
                startOffset: startOffset + len,
                endOffset: startOffset + len,
                collapsed: true,
                style,
            },
        ];

        const doMutation: ICommandInfo<IRichTextEditingMutationParams> = {
            id: RichTextEditingMutation.id,
            params: {
                unitId,
                actions: [],
                textRanges,
            },
        };

        const styleCache = docMenuStyleService.getStyleCache();
        const curTextRun = getTextRunAtPosition(body.textRuns ?? [], startOffset + oldTextLen, styleCache);

        const textX = new TextX();
        const jsonX = JSONX.getInstance();

        if (!previousActiveRange.collapsed && isCompositionStart) {
            const { dos, retain } = BuildTextUtils.selection.getDeleteActions(previousActiveRange, segmentId, 0, body);

            textX.push(...dos);

            doMutation.params!.textRanges = [{
                startOffset: startOffset + len + retain,
                endOffset: startOffset + len + retain,
                collapsed: true,
            }];
        } else {
            textX.push({
                t: TextXActionType.RETAIN,
                len: startOffset,
            });
        }

        if (oldTextLen > 0) {
            textX.push({
                t: TextXActionType.DELETE,
                len: oldTextLen,
            });
        }

        textX.push({
            t: TextXActionType.INSERT,
            body: {
                dataStream: newText,
                textRuns: curTextRun
                    ? [{
                        ...curTextRun,
                        st: 0,
                        ed: newText.length,
                    }]
                    : [],
            },
            len: newText.length,
        });

        const path = getRichTextEditPath(docDataModel, segmentId);
        doMutation.params!.actions = jsonX.editOp(textX.serialize(), path);

        doMutation.params!.noHistory = !isCompositionEnd;

        doMutation.params!.isCompositionEnd = isCompositionEnd;

        const result = commandService.syncExecuteCommand<
            IRichTextEditingMutationParams,
            IRichTextEditingMutationParams
        >(doMutation.id, doMutation.params);

        imeInputManagerService.pushUndoRedoMutationParams(result, doMutation.params!);

        return Boolean(result);
    },
};
