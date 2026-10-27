import { functions } from "stylus"

async function onPlayersSideboardClosed() {
    const landscapes = cards?.Exile
    if (landscapes?.length >= 4) {
        functions.moveCard(landscapes[0], "Landscape1")
        functions.moveCard(landscapes[1], "Landscape2")
        functions.moveCard(landscapes[2], "Landscape3")
        functions.moveCard(landscapes[3], "Landscape4")
        functions.repositionCards()
    }
}