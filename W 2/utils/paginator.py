"""Paginador de embeds con botones."""

from __future__ import annotations

import discord


class Paginator(discord.ui.View):
    def __init__(self, pages: list[discord.Embed], author_id: int, timeout: float = 180):
        super().__init__(timeout=timeout)
        self.pages = pages
        self.author_id = author_id
        self.index = 0
        self.message: discord.Message | None = None
        self._refresh()

    def _refresh(self) -> None:
        total = len(self.pages)
        self.first.disabled = self.prev.disabled = self.index == 0
        self.next.disabled = self.last.disabled = self.index >= total - 1
        self.counter.label = f"{self.index + 1}/{total}"

    async def interaction_check(self, interaction: discord.Interaction) -> bool:
        if interaction.user.id != self.author_id:
            await interaction.response.send_message(
                "Estos botones son de quien uso el comando.", ephemeral=True
            )
            return False
        return True

    async def on_timeout(self) -> None:
        for child in self.children:
            child.disabled = True
        if self.message is not None:
            try:
                await self.message.edit(view=self)
            except discord.HTTPException:
                pass

    async def _go(self, interaction: discord.Interaction, index: int) -> None:
        self.index = max(0, min(index, len(self.pages) - 1))
        self._refresh()
        await interaction.response.edit_message(embed=self.pages[self.index], view=self)

    @discord.ui.button(label="<<", style=discord.ButtonStyle.secondary)
    async def first(self, interaction: discord.Interaction, _: discord.ui.Button):
        await self._go(interaction, 0)

    @discord.ui.button(label="<", style=discord.ButtonStyle.primary)
    async def prev(self, interaction: discord.Interaction, _: discord.ui.Button):
        await self._go(interaction, self.index - 1)

    @discord.ui.button(label="1/1", style=discord.ButtonStyle.secondary, disabled=True)
    async def counter(self, interaction: discord.Interaction, _: discord.ui.Button):
        pass

    @discord.ui.button(label=">", style=discord.ButtonStyle.primary)
    async def next(self, interaction: discord.Interaction, _: discord.ui.Button):
        await self._go(interaction, self.index + 1)

    @discord.ui.button(label=">>", style=discord.ButtonStyle.secondary)
    async def last(self, interaction: discord.Interaction, _: discord.ui.Button):
        await self._go(interaction, len(self.pages) - 1)


async def send_pages(interaction: discord.Interaction, pages: list[discord.Embed],
                     ephemeral: bool = False) -> None:
    if not pages:
        return
    if len(pages) == 1:
        if interaction.response.is_done():
            await interaction.followup.send(embed=pages[0], ephemeral=ephemeral)
        else:
            await interaction.response.send_message(embed=pages[0], ephemeral=ephemeral)
        return

    view = Paginator(pages, interaction.user.id)
    if interaction.response.is_done():
        view.message = await interaction.followup.send(
            embed=pages[0], view=view, ephemeral=ephemeral, wait=True
        )
    else:
        await interaction.response.send_message(embed=pages[0], view=view, ephemeral=ephemeral)
        view.message = await interaction.original_response()
