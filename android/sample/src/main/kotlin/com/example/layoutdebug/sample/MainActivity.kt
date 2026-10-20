package com.example.layoutdebug.sample

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.produceState
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import io.github.antonchuraev99.layoutdebug.LayoutDebug
import kotlinx.coroutines.delay

/**
 * A plain Compose screen to try the agent on: a Scaffold (its slots are subcompositions)
 * around a LazyColumn (every item is a subcomposition of its own).
 */
class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        setContent {
            MaterialTheme {
                SampleScreen()
            }
        }
    }
}

private val rows = List(30) { "Row ${it + 1}" }

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SampleScreen() {
    Scaffold(
        topBar = { TopAppBar(title = { Text("layout-debug sample") }) },
    ) { padding ->
        LazyColumn(
            modifier = Modifier.fillMaxSize(),
            contentPadding = PaddingValues(
                start = 16.dp,
                end = 16.dp,
                top = padding.calculateTopPadding() + 8.dp,
                bottom = padding.calculateBottomPadding() + 16.dp,
            ),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            item { AgentStatus() }
            item { Actions() }
            item { SaveCard() }
            items(rows) { title -> RowCard(title) }
        }
    }
}

@Composable
private fun AgentStatus() {
    // The noop artifact answers false in release; in debug the server comes up right after start.
    val running by produceState(LayoutDebug.isRunning) {
        while (!value) {
            delay(500)
            value = LayoutDebug.isRunning
        }
    }
    Text(
        text = if (running) "layout-debug agent is listening" else "layout-debug agent is not running",
        style = MaterialTheme.typography.bodyMedium,
    )
}

@Composable
private fun Actions() {
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Button(onClick = {}) { Text("Primary") }
        OutlinedButton(onClick = {}) { Text("Secondary") }
    }
}

/**
 * A Text with exactly its card's box (no padding between them): the tree folds the two into
 * one node, which must keep "Save".
 */
@Composable
private fun SaveCard() {
    Card {
        Text("Save")
    }
}

@Composable
private fun RowCard(title: String) {
    Card(modifier = Modifier.fillMaxWidth()) {
        Row(
            modifier = Modifier.padding(16.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Box(
                modifier = Modifier
                    .size(40.dp)
                    .background(MaterialTheme.colorScheme.primary, CircleShape),
            )
            Spacer(Modifier.width(16.dp))
            Column {
                Text(title, style = MaterialTheme.typography.titleMedium)
                Text("Select me in the layout-debug window", style = MaterialTheme.typography.bodySmall)
            }
        }
    }
}
