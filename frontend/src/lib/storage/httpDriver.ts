// @depends-on ../../api.ts (httpApi)
// @depends-on ./driver.ts
import { httpApi } from "../../api";
import type { StorageDriver } from "./driver";

export class HttpDriver implements StorageDriver {
  createCard = httpApi.createCard;
  getCard = httpApi.getCard;
  cardTitle = httpApi.cardTitle;
  cardTitles = httpApi.cardTitles;
  patchCard = httpApi.patchCard;
  cardImpact = httpApi.cardImpact;
  deleteCard = httpApi.deleteCard;
  listCards = httpApi.listCards;

  putLink = httpApi.putLink;
  patchLink = httpApi.patchLink;
  deleteLink = httpApi.deleteLink;

  listTags = httpApi.listTags;
  createTag = httpApi.createTag;
  patchTag = httpApi.patchTag;
  addTagAlias = httpApi.addTagAlias;
  removeTagAlias = httpApi.removeTagAlias;
  resolveTag = httpApi.resolveTag;
  mergeTag = httpApi.mergeTag;
  deletePreview = httpApi.deletePreview;
  deleteTag = httpApi.deleteTag;
  assignTag = httpApi.assignTag;
  unassignTag = httpApi.unassignTag;

  listBoards = httpApi.listBoards;
  createBoard = httpApi.createBoard;
  renameBoard = httpApi.renameBoard;
  deleteBoard = httpApi.deleteBoard;
  getBoard = httpApi.getBoard;
  addToBoard = httpApi.addToBoard;
  patchBoardCards = httpApi.patchBoardCards;
  removeFromBoard = httpApi.removeFromBoard;
  createBoardGroup = httpApi.createBoardGroup;
  patchBoardGroup = httpApi.patchBoardGroup;
  deleteBoardGroup = httpApi.deleteBoardGroup;

  syncExport = httpApi.syncExport;
  syncDiff = httpApi.syncDiff;
  syncApply = httpApi.syncApply;

  uploadMedia = httpApi.uploadMedia;
  mediaInfo = httpApi.mediaInfo;
  cleanupMedia = httpApi.cleanupMedia;
  getConceptGraph = httpApi.getConceptGraph;
}