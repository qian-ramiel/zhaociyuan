from server.app.models import MotionBinding, PersonaSettings, ProviderSettings


DEFAULT_PERSONA = PersonaSettings(characterName="小璃")
DEFAULT_PROVIDERS = ProviderSettings()

MOTION_LABELS = [
    ("idle", "待机"),
    ("listening", "倾听"),
    ("thinking", "思考"),
    ("speaking", "说话"),
    ("happy", "开心"),
    ("angry", "生气"),
    ("sad", "悲伤"),
    ("joy", "快乐"),
    ("surprised", "惊讶"),
    ("greeting", "打招呼"),
    ("agree", "同意"),
    ("refuse", "拒绝"),
    ("farewell", "告别"),
]

DEFAULT_MOTIONS = [
    MotionBinding(
        semantic=semantic,
        label=label,
        priority=4 if index < 4 else 6,
    )
    for index, (semantic, label) in enumerate(MOTION_LABELS)
]
