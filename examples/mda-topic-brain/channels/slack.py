from managed_deepagents import channels

channel = channels.slack(
    name="OpenWiki Topic Brain",
    description="Researches a focused topic using public and internal sources",
    background_color="#1A6FB5",
)
