package com.yourorg.imagegallerypreview.service

import com.intellij.openapi.components.PersistentStateComponent
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.State
import com.intellij.openapi.components.Storage
import com.intellij.openapi.components.StoragePathMacros
import com.intellij.openapi.components.service
import com.intellij.openapi.project.Project

@Service(Service.Level.PROJECT)
@State(
    name = "ImageGalleryPreviewSettings",
    storages = [Storage(StoragePathMacros.WORKSPACE_FILE)]
)
class GallerySettingsService : PersistentStateComponent<GallerySettingsService.State> {
    data class State(
        var resourceStringLinksEnabled: Boolean = false
    )

    private var state = State()

    var resourceStringLinksEnabled: Boolean
        get() = state.resourceStringLinksEnabled
        set(value) {
            state.resourceStringLinksEnabled = value
        }

    override fun getState(): State = state

    override fun loadState(state: State) {
        this.state = state
    }

    companion object {
        fun getInstance(project: Project): GallerySettingsService = project.service()
    }
}
