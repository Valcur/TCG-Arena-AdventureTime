async function onPlayersSideboardClosed() {
    const landscapes = cards?.Exile
    if (landscapes?.length >= 4) {
        await functions.moveCard(landscapes[0], "Landscape1")
        await functions.moveCard(landscapes[1], "Landscape2")
        await functions.moveCard(landscapes[2], "Landscape3")
        await functions.moveCard(landscapes[3], "Landscape4")
        await functions.repositionCards()
    }
}

async function swapLandscapes(index) {
    const landscapeA = cards?.["Landscape" + index]?.[0]
    const landscapeB = cards?.["Landscape" + (index + 1)]?.[0]
    if (!landscapeA || !landscapeB) return
    await functions.moveCard(landscapeB, "Landscape" + index)
    await functions.moveCard(landscapeA, "Landscape" + (index + 1))
    await functions.repositionCards()
}

async function flipLandscape(index) {
    const landscape = cards?.["Landscape" + index]?.[0]
    if (!landscape) return
    await functions.hideCards([landscape], landscape.hiddenTo?.status === "no" ? "yes" : "no")
    await functions.repositionCards()
}

async function freezeLandscape(index) {
    const landscape = cards?.["Landscape" + index]?.[0]
    if (!landscape) return
    await functions.updateCards([landscape], {
        draggableTokens:
            [
                {
                    "id": "Frozen",
                    "name": "Frozen",
                    "image": "https://valcur.github.io/TCG-Arena-AdventureTime/Images/frozen.png",
                    "count": (landscape?.draggableTokens?.[0]?.count ?? 0) + 1
                }
            ]
    })
    await functions.repositionCards()
}