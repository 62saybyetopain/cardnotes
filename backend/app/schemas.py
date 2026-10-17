from enum import Enum
from typing import Annotated, Optional

from pydantic import BaseModel, Field, StringConstraints

Name = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=200)]
Id = Annotated[str, StringConstraints(min_length=1, max_length=64)]
Coord = Annotated[float, Field(allow_inf_nan=False)]
Size = Annotated[float, Field(gt=0, allow_inf_nan=False)]


class Axis(str, Enum):
    LOCATION = "location"
    DOMAIN = "domain"  # 向後相容別名，寫入時正規化為 location
    TYPE = "type"
    CONCEPT = "concept"
    FREE = "free"

    def normalized(self) -> str:
        if self == Axis.DOMAIN:
            return Axis.LOCATION.value
        return self.value


class CardType(str, Enum):
    UNTYPED = "untyped"
    CONCEPT = "concept"
    MECHANISM = "mechanism"
    HYPOTHESIS = "hypothesis"
    METHOD = "method"
    CASE = "case"
    SOURCE = "source"
    QUESTION = "question"


class CurationStatus(str, Enum):
    INBOX = "inbox"
    CURATED = "curated"


class CardCreate(BaseModel):
    title: str = Field("", max_length=500)
    body: str = ""
    card_type: CardType = CardType.UNTYPED
    curation_status: CurationStatus = CurationStatus.INBOX
    tag_ids: list[Id] = []


class CardPatch(BaseModel):
    title: Optional[str] = Field(None, max_length=500)
    body: Optional[str] = None
    card_type: Optional[CardType] = None
    curation_status: Optional[CurationStatus] = None
    expected_updated_at: str


class TagCreate(BaseModel):
    name: Name
    axis: Axis
    facet: Optional[Name] = None
    definition: str = Field("", max_length=1000)
    parent_id: Optional[Id] = None


class TagPatch(BaseModel):
    name: Optional[Name] = None
    facet: Optional[Name] = None
    definition: Optional[str] = Field(None, max_length=1000)
    parent_id: Optional[Id] = None  # 明確傳 null 代表移到最上層（用 model_fields_set 判斷有沒有傳）


class TagAliasCreate(BaseModel):
    alias: Name


class TagResolveRequest(BaseModel):
    query: Name
    axis: Optional[Axis] = None


class TagMergeRequest(BaseModel):
    target_id: Id


class RelationType(str, Enum):
    SUPPORT = "support"
    REFUTE = "refute"
    INFLUENCE = "influence"
    INSTANCE_OF = "instance_of"
    APPLIED_TO = "applied_to"
    EXTEND = "extend"


class LinkStatus(str, Enum):
    CONFIRMED = "confirmed"
    HYPOTHESIS = "hypothesis"


class LinkPut(BaseModel):
    source_id: Optional[Id] = None
    target_id: Optional[Id] = None
    card_id: Optional[Id] = None  # 相容舊呼叫端
    other_id: Optional[Id] = None  # 相容舊呼叫端
    relation_type: RelationType = RelationType.EXTEND
    status: LinkStatus = LinkStatus.CONFIRMED
    reason: str = Field("", max_length=1000)


class LinkPatch(BaseModel):
    old_relation_type: Optional[RelationType] = None
    relation_type: Optional[RelationType] = None
    status: Optional[LinkStatus] = None
    reason: Optional[str] = Field(None, max_length=1000)


class BoardGroupCreate(BaseModel):
    label: str = Field("", max_length=200)
    x: Coord
    y: Coord
    w: Size = 360.0
    h: Size = 240.0
    color: str = Field("slate", max_length=32)


class BoardGroupPatch(BaseModel):
    label: Optional[str] = Field(None, max_length=200)
    x: Optional[Coord] = None
    y: Optional[Coord] = None
    w: Optional[Size] = None
    h: Optional[Size] = None
    color: Optional[str] = Field(None, max_length=32)


class BoardCreate(BaseModel):
    name: Name


class BoardPatch(BaseModel):
    name: Name


class BoardCardAdd(BaseModel):
    card_id: Id
    x: Coord
    y: Coord
    w: Optional[Size] = None
    h: Optional[Size] = None


class BoardCardPos(BaseModel):
    card_id: Id
    x: Coord
    y: Coord
    w: Optional[Size] = None
    h: Optional[Size] = None


class BoardCardsPatch(BaseModel):
    items: list[BoardCardPos] = Field(min_length=1, max_length=500)


class SyncCardItem(BaseModel):
    id: Id
    title: str = ""
    body: str = ""
    card_type: CardType = CardType.UNTYPED
    curation_status: CurationStatus = CurationStatus.INBOX
    created_at: str
    updated_at: str


class SyncTagItem(BaseModel):
    id: Id
    name: str
    axis: Axis
    facet: Optional[str] = None
    definition: str = ""
    parent_id: Optional[Id] = None
    aliases: list[str] = []


class SyncCardTagItem(BaseModel):
    card_id: Id
    tag_id: Id


class SyncLinkItem(BaseModel):
    source_id: Id
    target_id: Id
    relation_type: RelationType = RelationType.EXTEND
    status: LinkStatus = LinkStatus.CONFIRMED
    reason: str = ""


class SyncBoardItem(BaseModel):
    id: Id
    name: str


class SyncBoardCardItem(BaseModel):
    board_id: Id
    card_id: Id
    x: Optional[float] = None
    y: Optional[float] = None
    w: Optional[float] = None
    h: Optional[float] = None


class SyncPackage(BaseModel):
    version: int = 1
    exported_at: str
    source_device: str = "pc"
    cards: list[SyncCardItem] = []
    tags: list[SyncTagItem] = []
    card_tags: list[SyncCardTagItem] = []
    links: list[SyncLinkItem] = []
    boards: list[SyncBoardItem] = []
    board_cards: list[SyncBoardCardItem] = []


class SyncApplyRequest(BaseModel):
    card_ids_to_add: list[Id] = []
    card_ids_to_update: list[Id] = []
    tag_ids_to_add: list[Id] = []
    tag_ids_to_update: list[Id] = []
    card_tags_to_add: list[SyncCardTagItem] = []
    links_to_add: list[SyncLinkItem] = []
    board_cards_to_add: list[SyncBoardCardItem] = []
    package: SyncPackage
