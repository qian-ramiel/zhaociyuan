from typing import Any, Dict, List, Literal, Optional

from pydantic import BaseModel, Field


Emotion = Literal["neutral", "happy", "angry", "sad", "joy", "surprised"]


class ActionCommand(BaseModel):
    name: str
    intensity: float = Field(default=0.5, ge=0, le=1)


class CompanionReply(BaseModel):
    text: str
    speech: str
    emotion: Emotion = "neutral"
    actions: List[ActionCommand] = Field(default_factory=list)
    memoryCandidates: List[str] = Field(default_factory=list)
    custom: Dict[str, Any] = Field(default_factory=dict)
    switchAppearance: Optional[str] = None
    imagePrompt: Optional[str] = None


class PersonaSettings(BaseModel):
    characterName: str = "未命名"
    userName: str = "你"
    background: str = ""
    personality: str = "自然、真诚、有自己的判断，不使用客服腔。"
    relationship: str = "长期陪伴的伙伴。"
    speakingStyle: str = "简洁、自然，像熟悉的朋友一样交流。"
    likes: str = ""
    dislikes: str = ""
    boundaries: str = "不假装已经完成没有完成的事情。"
    systemPrompt: str = ""
    exampleDialogue: str = ""
    replyLength: Literal["short", "medium", "long"] = "medium"
    initiative: int = Field(default=5, ge=0, le=10)


class LlmSettings(BaseModel):
    provider: str = "compatible"
    baseUrl: str = ""
    apiKey: str = ""
    model: str = ""
    temperature: float = Field(default=0.8, ge=0, le=2)
    maxTokens: int = Field(default=800, ge=128, le=32768)
    streaming: bool = True
    jsonMode: bool = False
    hasApiKey: bool = False


class TtsSettings(BaseModel):
    provider: Literal["local", "openai", "custom", "minimax"] = "local"
    baseUrl: str = ""
    apiKey: str = ""
    model: str = "kokoro-multi-lang-v1_1"
    voice: str = "zf_xiaobei"
    speed: float = Field(default=1.0, ge=0.5, le=1.5)
    autoplay: bool = True
    streaming: bool = True
    hasApiKey: bool = False


class AsrSettings(BaseModel):
    provider: Literal["sherpa-onnx"] = "sherpa-onnx"
    language: str = "auto"
    silenceSeconds: float = Field(default=1.2, ge=0.5, le=3)
    continuous: bool = False
    autoSend: bool = False


class ProviderSettings(BaseModel):
    llm: LlmSettings = Field(default_factory=LlmSettings)
    tts: TtsSettings = Field(default_factory=TtsSettings)
    asr: AsrSettings = Field(default_factory=AsrSettings)
    vision: LlmSettings = Field(default_factory=LlmSettings)
    visionUseChat: bool = True
    image: 'ImageSettings' = Field(default_factory=lambda: ImageSettings())


class MotionBinding(BaseModel):
    semantic: str
    label: str
    motionGroup: str = ""
    motionIndex: int = 0
    expression: str = ""
    priority: int = Field(default=5, ge=1, le=10)
    interruptible: bool = True
    cooldownMs: int = Field(default=800, ge=0, le=60000)


class SettingsResponse(BaseModel):
    persona: PersonaSettings
    providers: ProviderSettings
    motions: List[MotionBinding]


class ChatRequest(BaseModel):
    content: str = Field(min_length=1, max_length=20000)
    screen: Optional['ScreenContext'] = None
    requestId: str = Field(default="", pattern=r'^(?:[a-zA-Z0-9-]{1,80})?$')
    source: Literal["text", "voice", "workflow"] = "text"


class SpeechRequest(BaseModel):
    text: str = Field(min_length=1, max_length=5000)
    requestId: Optional[str] = Field(default=None, pattern=r'^[a-zA-Z0-9-]{1,80}$')


class MemoryCreate(BaseModel):
    category: Literal["profile", "relationship", "project"]
    content: str = Field(min_length=1, max_length=4000)


class MemoryPatch(BaseModel):
    content: Optional[str] = Field(default=None, min_length=1, max_length=4000)
    enabled: Optional[bool] = None


class EnabledPatch(BaseModel):
    enabled: bool


class ScreenContext(BaseModel):
    imageData: str = Field(max_length=8_000_000, pattern=r'^data:image/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$')
    capturedAt: str = Field(max_length=100)
    sourceName: str = Field(max_length=300)


class ImageSettings(BaseModel):
    baseUrl: str = ""
    apiKey: str = ""
    model: str = ""
    size: Literal["1024x1024", "1024x1536", "1536x1024"] = "1024x1024"
    mode: Literal["off", "manual", "suggest", "auto"] = "manual"
    style: str = "二次元插画，自然光，细致的角色和场景"
    hasApiKey: bool = False
    cooldown: int = Field(default=120, ge=0, le=7200)
    hourlyLimit: int = Field(default=6, ge=1, le=100)


class DesktopSettings(BaseModel):
    language: Optional[Literal['zh', 'en', 'ja']] = None
    visible: bool = True
    clickThrough: bool = False
    alwaysOnTop: bool = True
    menu: Literal['hover', 'always'] = 'hover'
    showGrip: bool = True
    gazeEnabled: bool = True
    visionEnabled: bool = True
    hearingEnabled: bool = True
    speechEnabled: bool = True
    characterScale: float = Field(default=1, ge=0.65, le=1.6, allow_inf_nan=False)
    bubbleWidth: int = Field(default=90, ge=60, le=100)
    bubbleHeight: int = Field(default=72, ge=56, le=280)
    bubbleFontSize: int = Field(default=13, ge=11, le=20)
    bubbleAutoHide: int = Field(default=8, ge=0, le=120)
    showBubble: bool = True
    pushToTalk: bool = True
    pushToTalkKey: Literal['CommandOrControl+Shift+Space', 'Control+Alt+Space', 'F8', 'ShiftLeft+ShiftRight'] = 'ShiftLeft+ShiftRight'


class ScreenSettings(BaseModel):
    enabled: bool = False
    paused: bool = False
    sourceId: str = ""
    sourceName: str = ""
    quality: Literal['standard', 'high'] = 'high'
    onMessage: bool = True
    periodic: bool = False
    interval: int = Field(default=30, ge=5, le=3600)
    onChange: bool = False
    changeThreshold: float = Field(default=0.12, ge=0.01, le=1)
    region: Optional[Dict[str, float]] = None


class CompanionSettings(BaseModel):
    characterId: str = "companion"
    activeAppearanceId: str = ""
    previousAppearanceId: str = ""
    mode: str = Field(default="daily", min_length=1, max_length=100)
    allowAutoAppearance: bool = False
    modeAppearances: Dict[str, str] = Field(default_factory=dict)
    proactive: bool = False
    cooldown: int = Field(default=180, ge=10, le=7200)
    hourlyLimit: int = Field(default=20, ge=1, le=200)
    quietStart: str = Field(default="23:00", pattern=r'^(?:[01]\d|2[0-3]):[0-5]\d$')
    quietEnd: str = Field(default="08:00", pattern=r'^(?:[01]\d|2[0-3]):[0-5]\d$')
    focus: bool = False
    autoMemory: bool = False
    screen: ScreenSettings = Field(default_factory=ScreenSettings)


class AppearanceCreate(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    assetId: str
    framing: Literal["full", "half", "mini"] = "full"
    scale: float = Field(default=1, ge=0.3, le=3)
    aliases: List[str] = Field(default_factory=list, max_length=20)
    bindings: List[MotionBinding] = Field(default_factory=list)
    gaze: 'GazeSettings' = Field(default_factory=lambda: GazeSettings())


class GazeSettings(BaseModel):
    enabled: bool = True
    head: bool = True
    strength: float = Field(default=0.7, ge=0, le=1)
    trigger: Literal['hover', 'click'] = 'hover'


class RoleCreate(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    intro: str = Field(default='', max_length=1000)
    personality: str = Field(default='', max_length=8000)


class ModeObservation(BaseModel):
    periodic: bool = False
    onChange: bool = False
    interval: int = Field(default=30, ge=5, le=3600)
    changeThreshold: float = Field(default=0.12, ge=0.01, le=1)


class CompanionMode(BaseModel):
    id: str = Field(min_length=1, max_length=100)
    name: str = Field(min_length=1, max_length=80)
    prompt: str = Field(default='', max_length=8000)
    screenAllowed: bool = False
    proactive: bool = False
    cooldown: int = Field(default=180, ge=10, le=7200)
    hourlyLimit: int = Field(default=20, ge=1, le=200)
    quietStart: str = Field(default='23:00', pattern=r'^(?:[01]\d|2[0-3]):[0-5]\d$')
    quietEnd: str = Field(default='08:00', pattern=r'^(?:[01]\d|2[0-3]):[0-5]\d$')
    replyLength: Literal['inherit', 'short', 'medium', 'long'] = 'inherit'
    observation: ModeObservation = Field(default_factory=ModeObservation)


class Workflow(BaseModel):
    id: str = Field(default="", max_length=100)
    name: str = Field(min_length=1, max_length=80)
    enabled: bool = True
    trigger: Literal["message", "manual", "periodic", "change"] = "message"
    mode: str = Field(default="all", min_length=1, max_length=100)
    keyword: str = Field(default="", max_length=100)
    prompt: str = Field(default="", max_length=8000)


class ObserveRequest(BaseModel):
    screen: ScreenContext
    trigger: Literal["manual", "periodic", "change"] = "manual"
    workflowId: Optional[str] = None


class ImageRequest(BaseModel):
    prompt: str = Field(min_length=1, max_length=4000)


ProviderSettings.model_rebuild()
ChatRequest.model_rebuild()
AppearanceCreate.model_rebuild()
