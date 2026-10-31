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

async function swapLandscapes(index) {
    const landscapeA = cards?.["Landscape" + index]?.[0]
    const landscapeB = cards?.["Landscape" + (index + 1)]?.[0]
    if (!landscapeA || !landscapeB) return
    functions.moveCard(landscapeB, "Landscape" + index)
    functions.moveCard(landscapeA, "Landscape" + (index + 1))
    functions.repositionCards()
}

async function flipLandscape(index) {
    const landscape = cards?.["Landscape" + index]?.[0]
    if (!landscape) return
    functions.hideCards([landscape], landscape.hiddenTo?.status === "no" ? "yes" : "no")
    functions.repositionCards()
}